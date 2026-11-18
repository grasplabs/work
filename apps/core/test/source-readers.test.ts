import { brainOf, recallBudgetMax } from "@grasp-os/brain-next/contract";
import { routerSecretHeader } from "@grasp-os/shared/router";
import type { SourceReader } from "@grasp-os/shared/source-readers";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  addSource,
  changeSourceReaders,
  readSourceVersionAs,
  recallAs,
  workBrain,
} from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { inJurisdiction, workspace } from "../src/durable-objects.ts";
import worker from "../src/index.ts";
import {
  claimConnectedTokens,
  heldPrincipalsOf,
  keepSignInAddress,
} from "../src/source-readers.ts";
import { says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { objectsHolding, tablesHolding } from "./brain-next-traces.ts";
import {
  consentCode,
  googleAddressUrl,
  googleHoldUrl,
} from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { fakeProvider } from "./model-provider.ts";
import { noProducers } from "./no-producers.ts";
import {
  acmeTenant,
  entraClient,
  googleClient,
  otherTenant,
} from "./sign-in-config.ts";
import {
  coreOrigin,
  entraPerson,
  googlePerson,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  signedInWithRole,
  unique,
  uniqueWord,
  whoami,
  withSignIn,
} from "./sign-in.ts";
import { connectDb, testBinding } from "./test-env.ts";

// Readers copied from where an item lives (GRA-1761; the threat model is
// on the issue): who may read it is the list the system gives, and core
// counts a person in it only by the accounts they proved are theirs, at
// every read. These start from the ways it can fail: a stale list after a
// narrowing, an address or an account nobody here proved, a link, a group,
// someone who left, an account disconnected, and code acting for someone.

const idp = mockIdp();

/** Signing a dozen people in can be slow on CI. */
const setUpTime = { timeout: 120_000 };

/** A member signed in with Microsoft, and the account the reader list names them by. */
const microsoftMember = async () => {
  const { userId, person, session } = await signedInWithRole(idp, "user");
  const account: SourceReader = {
    kind: "account",
    provider: "microsoft",
    tenant: acmeTenant,
    account: String(person.oid),
  };
  return {
    userId,
    session,
    account,
    oid: String(person.oid),
    email: String(person.email),
    name: String(person.name),
  };
};

/** The provider's redirect back to core, with `session`, run to its end. */
const backFromProvider = async (
  session: string,
  query: Record<string, string>,
  coreEnv: Env = env
): Promise<void> => {
  const headers = new Headers({ cookie: session });
  headers.set(routerSecretHeader, env.ROUTER_SECRET);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(
      `${coreOrigin}/api/connections/callback?${new URLSearchParams(query).toString()}`,
      { redirect: "manual", headers }
    ),
    coreEnv,
    ctx
  );
  await waitOnExecutionContext(ctx);
  if (response.headers.get("location")?.includes("connectionError") === true) {
    throw new Error(`Not connected: ${response.headers.get("location")}`);
  }
};

/**
 * `who` connects their own Google account, as the Integrations page and
 * Google's consent do: Google's verified address for it is theirs. The
 * reader its file lists name it by, and its connection's ID.
 */
const connectedGoogle = async (who: {
  session: string;
  email: string;
}): Promise<{ id: string; account: SourceReader }> => {
  const { core } = await openRpc(who.session);
  const api = core.authenticate();
  const { url } = await api.connections.start({
    provider: "google",
    scope: "personal",
    returnTo: "/integrations",
  });
  const flow = new URL(url);
  const [local = ""] = who.email.split("@");
  await backFromProvider(who.session, {
    code: consentCode(
      flow,
      "acme.test",
      local,
      flow.searchParams.get("scope") ?? ""
    ),
    state: flow.searchParams.get("state") ?? "",
  });
  const connections = await api.connections.list();
  const connection = connections.find(({ provider }) => provider === "google");
  if (connection === undefined) {
    throw new Error("No Google connection");
  }
  return {
    id: connection.id,
    account: {
      kind: "account",
      provider: "google",
      tenant: "acme.test",
      account: who.email,
    },
  };
};

/** `who` disconnects their own connection `connectionId`. */
const disconnect = async (
  who: { session: string },
  connectionId: string
): Promise<void> => {
  const { core } = await openRpc(who.session);
  await core.authenticate().connections.disconnect(connectionId);
};

/** `who` connects their own Microsoft account, as the Integrations page and Entra's consent do. */
const connectedMicrosoft = async (
  who: { session: string; oid: string },
  coreEnv: Env = env
): Promise<void> => {
  const { core } = await openRpc(who.session);
  const { url } = await core.authenticate().connections.start({
    provider: "microsoft",
    scope: "personal",
    returnTo: "/integrations",
  });
  const authorization = new URL(url);
  await backFromProvider(
    who.session,
    {
      code: consentCode(authorization, acmeTenant, who.oid),
      state: authorization.searchParams.get("state") ?? "",
    },
    coreEnv
  );
};

/** How many of core's reader tokens name `userId` as the person holding them. */
const tokensClaimedBy = async (userId: string): Promise<number> => {
  const claimed = await env.DB.prepare(
    "SELECT count(*) AS n FROM source_reader_tokens WHERE person = ?"
  )
    .bind(userId)
    .first<{ n: number }>();
  return claimed?.n ?? 0;
};

/** An admin removes and erases `who`, and the clock runs the erasure to its end. */
const erasedBy = async (
  admin: Awaited<ReturnType<typeof signedInApi>>,
  who: { userId: string; name: string }
): Promise<void> => {
  await admin.api.members.remove(who.userId);
  await admin.api.members.erase(who.userId, who.name);
  await runMinuteTasks();
};

/** An item kept with `marker` for `readers`. */
const sharedItem = async (
  marker: string,
  readers: SourceReaders
): Promise<SourceRef> => {
  const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
  await addSource(env, {
    source,
    change: crypto.randomUUID(),
    text: `Warehouse lease terms ${marker}`,
    readers,
  });
  return source;
};

/** Whether `personId`, reading as themselves (or as their teams), finds `source` by `marker`. */
const finds = async (
  personId: string,
  source: SourceRef,
  marker: string,
  personal = true
): Promise<boolean> => {
  const { items } = await recallAs(env, personId, {
    personal,
    question: marker,
    budget: { tokens: recallBudgetMax },
  });
  return items.some(
    ({ source: found, text }) => found.id === source.id && text.includes(marker)
  );
};

/** Whether any row of core's token table holds `text`, an address or an ID. */
const tokensHold = async (text: string): Promise<boolean> => {
  const { results } = await env.DB.prepare(
    "SELECT * FROM source_reader_tokens"
  ).all();
  return JSON.stringify(results).toLowerCase().includes(text.toLowerCase());
};

/** The newcomer given `address` once an admin released it: signed in with Google under it. */
const newcomerAt = async (
  admin: {
    api: { members: { releaseAddress: (email: string) => Promise<unknown> } };
  },
  address: string
): Promise<string> => {
  await admin.api.members.releaseAddress(address);
  const { userId } = await whoami(
    await signedIn(idp, "google", googlePerson({ email: address }))
  );
  return userId;
};

/**
 * Holds every person's erasure in the Brain's shared store (`held`), as a
 * Brain failing or restoring would: what waits for it waits too.
 */
const holdingBrainErasures = async (held: boolean): Promise<void> => {
  await runInDurableObject(
    inJurisdiction(env, env.BRAIN_STORE).getByName("brain"),
    (_instance, state) => {
      state.storage.sql.exec(
        held
          ? `CREATE TRIGGER IF NOT EXISTS test_hold_person BEFORE INSERT ON erasures
            WHEN NEW.kind = 'person'
            BEGIN SELECT RAISE(ABORT, 'held by the test'); END`
          : "DROP TRIGGER IF EXISTS test_hold_person"
      );
    }
  );
};

/** The providers Worker's fake of Google: tells it the address it gives `subject` from now on. */
const googleGives = async (
  subject: string,
  email: string | null
): Promise<void> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (
    typeof providers !== "object" ||
    providers === null ||
    !("fetch" in providers) ||
    typeof providers.fetch !== "function"
  ) {
    throw new TypeError("Expected the providers Worker");
  }
  await Reflect.apply(providers.fetch, providers, [
    googleAddressUrl,
    { method: "POST", body: JSON.stringify({ subject, email }) },
  ]);
};

/** Ends `connectionId`'s access token and renews it, as its next use does; then the drain runs. */
const renewedOnly = async (connectionId: string): Promise<void> => {
  await connectDb()
    .prepare(
      "UPDATE connection_tokens SET access_expires_at = 0 WHERE connection_id = ?"
    )
    .bind(connectionId)
    .run();
  await outcome(
    env.CONNECT.readSyncPage({
      connectionId,
      feed: "gmail",
      place: "own",
      cursor: null,
    })
  );
};

/** As `renewedOnly`, then the clock's drain of what connect recorded. */
const renewed = async (connectionId: string): Promise<void> => {
  await renewedOnly(connectionId);
  await runMinuteTasks();
};

const dayMs = 24 * 60 * 60 * 1000;
const hourMs = 60 * 60 * 1000;

/** Whether `personId`, as of `at` from now, finds `source` by `marker`. */
const findsLater = async (
  laterMs: number,
  personId: string,
  source: SourceRef,
  marker: string
): Promise<boolean> => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + laterMs });
  try {
    return await finds(personId, source, marker);
  } finally {
    vi.useRealTimers();
  }
};

/**
 * Whether the model saw `secret` in a turn `personId` asked about `topic`
 * in their own direct message on a chat app, which recalls as them with
 * no web session.
 */
const findsInDirectMessage = async (
  admin: Awaited<ReturnType<typeof signedInApi>>,
  personId: string,
  topic: string,
  secret: string
): Promise<boolean> => {
  const agentId = crypto.randomUUID();
  await requestGranted(idp, admin, {
    subject: { type: "agent", agentId },
    object: { type: "platform" },
    actions: ["brain"],
    binding: "BRAIN",
  });
  const provider = await fakeProvider(says("Noted."));
  await workspace(env, personalWorkspaceId(personId)).askThrough(
    personId,
    agentId,
    "slack",
    `What about ${topic}?`,
    undefined,
    { kind: "direct" }
  );
  return JSON.stringify(provider.requests.map(({ body }) => body)).includes(
    secret
  );
};

/** Sets when `personId`'s sign-in last confirmed their address to `agoMs` ago. */
const signInConfirmedAgo = async (
  personId: string,
  agoMs: number
): Promise<void> => {
  await env.DB.prepare(
    "UPDATE accounts SET verified_email_at = ? WHERE user_id = ? AND verified_email IS NOT NULL"
  )
    .bind(Date.now() - agoMs, personId)
    .run();
};

/** Connect as it is, but for `method`, which fails as an unreachable connect does. */
const connectFailing = (method: string): Env["CONNECT"] =>
  new Proxy(env.CONNECT, {
    get: (target, key) => {
      if (key === method) {
        return () => {
          throw new Error("connect unreachable");
        };
      }
      const value: unknown = Reflect.get(target, key);
      return value;
    },
  });

/** The providers Worker's fake of Google, asked at a control URL. */
const fakeGoogle = async (
  url: string,
  init?: RequestInit
): Promise<Response> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (
    typeof providers !== "object" ||
    providers === null ||
    !("fetch" in providers) ||
    typeof providers.fetch !== "function"
  ) {
    throw new TypeError("Expected the providers Worker");
  }
  const response: unknown = await Reflect.apply(providers.fetch, providers, [
    url,
    init,
  ]);
  if (!(response instanceof Response)) {
    throw new TypeError("Expected a response");
  }
  return response;
};

/** Waits, a bounded while, until a held call to Google is reached. */
const exchangeHeld = async (): Promise<void> => {
  for (let tries = 0; tries < 200; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- until it is reached
    const response = await fakeGoogle(googleHoldUrl);
    // oxlint-disable-next-line no-await-in-loop -- until it is reached
    const body: unknown = await response.json();
    const { reached } = z.object({ reached: z.boolean() }).parse(body);
    if (reached) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- until it is reached
    await scheduler.wait(25);
  }
  throw new Error("The held look-up was never reached");
};

const readersOf = (...readers: SourceReader[]): SourceReaders => ({
  kind: "readers",
  readers,
});

describe("readers copied from the source", () => {
  it(
    "lets exactly the eleven people a file is shared with read it, by the accounts they proved are theirs",
    setUpTime,
    async () => {
      const signedInMembers = await Promise.all(
        Array.from({ length: 10 }, async () => await microsoftMember())
      );
      // The eleventh signs in with Microsoft and is listed by a Google
      // account they connected as their own.
      const connector = await microsoftMember();
      const { account: connectorsGoogle } = await connectedGoogle(connector);
      const notListed = await microsoftMember();
      // Listed by a Google account they connected and then disconnected.
      const disconnected = await microsoftMember();
      const { id: disconnectedId, account: disconnectedGoogle } =
        await connectedGoogle(disconnected);
      await disconnect(disconnected, disconnectedId);
      // Signed in with Google, and not listed.
      const { userId: googleMember } = await whoami(
        await signedIn(idp, "google", googlePerson())
      );
      const marker = uniqueWord();
      const source = await sharedItem(
        marker,
        readersOf(
          ...signedInMembers.map(({ account }) => account),
          connectorsGoogle,
          disconnectedGoogle,
          // An account nobody here proved is theirs, and a link anyone
          // may have.
          {
            kind: "account",
            provider: "google",
            tenant: "acme.test",
            account: `nobody-${unique()}@acme.test`,
          },
          { kind: "link" }
        )
      );

      const readers = [...signedInMembers, connector].map(
        ({ userId }) => userId
      );
      const found = await Promise.all(
        [...readers, notListed.userId, disconnected.userId, googleMember].map(
          async (userId) => await finds(userId, source, marker)
        )
      );

      expect(found).toStrictEqual([
        ...readers.map(() => true),
        false,
        false,
        false,
      ]);
    }
  );

  it(
    "takes an item and its history from those a narrowing takes off, at once, and from everyone once only a link is left",
    setUpTime,
    async () => {
      const [stays, goes] = await Promise.all([
        microsoftMember(),
        microsoftMember(),
      ]);
      const marker = uniqueWord();
      const source = await sharedItem(
        marker,
        readersOf(stays.account, goes.account)
      );
      const narrowing = crypto.randomUUID();
      const narrowed = await changeSourceReaders(env, {
        source,
        change: narrowing,
        readers: readersOf(stays.account),
      });
      const firstVersion = async (personId: string) => {
        const version = await readSourceVersionAs(env, personId, {
          source,
          version: 1,
        });
        return version?.text ?? null;
      };
      const afterNarrowing = {
        stays: await finds(stays.userId, source, marker),
        goes: await finds(goes.userId, source, marker),
        staysHistory: await firstVersion(stays.userId),
        goesHistory: await firstVersion(goes.userId),
      };
      const repeated = await changeSourceReaders(env, {
        source,
        change: narrowing,
        readers: readersOf(stays.account),
      });
      const otherReaders = await outcome(
        changeSourceReaders(env, {
          source,
          change: narrowing,
          readers: readersOf(goes.account),
        })
      );
      // Gone at the source: only a link is left, which reaches nobody.
      const gone = await changeSourceReaders(env, {
        source,
        change: crypto.randomUUID(),
        readers: readersOf({ kind: "link" }),
      });

      expect({
        narrowed,
        afterNarrowing,
        repeated,
        otherReaders,
        gone,
        staysAfterGone: await finds(stays.userId, source, marker),
        neverAdded: await changeSourceReaders(env, {
          source: { producer: "upload", id: crypto.randomUUID() },
          change: crypto.randomUUID(),
          readers: { kind: "none" },
        }),
      }).toStrictEqual({
        narrowed: { source, version: 2 },
        afterNarrowing: {
          stays: true,
          goes: false,
          staysHistory: `Warehouse lease terms ${marker}`,
          goesHistory: null,
        },
        repeated: { source, version: 2 },
        otherReaders: "brain.source_change_taken",
        gone: { source, version: 3 },
        staysAfterGone: false,
        neverAdded: null,
      });
    }
  );

  it(
    "stops counting someone who left, or an account they disconnected, from the next read",
    setUpTime,
    async () => {
      const admin = await signedInApi(idp, "admin");
      const [leaver, connector] = await Promise.all([
        microsoftMember(),
        microsoftMember(),
      ]);
      const { id: connectionId, account: connectorsGoogle } =
        await connectedGoogle(connector);
      const marker = uniqueWord();
      const source = await sharedItem(
        marker,
        readersOf(leaver.account, connectorsGoogle)
      );
      const before = {
        leaver: await finds(leaver.userId, source, marker),
        connector: await finds(connector.userId, source, marker),
      };
      await admin.api.members.remove(leaver.userId);
      await disconnect(connector, connectionId);

      expect({
        before,
        leaver: await outcome(
          recallAs(env, leaver.userId, {
            personal: true,
            question: marker,
            budget: { tokens: recallBudgetMax },
          })
        ),
        connector: await finds(connector.userId, source, marker),
      }).toStrictEqual({
        before: { leaver: true, connector: true },
        leaver: "permission.person_inactive",
        connector: false,
      });
    }
  );

  it(
    "reaches the tenant's accounts for a tenant, never through a group, another system, another tenant's everyone, or code acting for someone",
    setUpTime,
    async () => {
      const member = await microsoftMember();
      const google = await signedIn(idp, "google", googlePerson());
      const { userId: googleMember } = await whoami(google);
      const tenantMarker = uniqueWord();
      const tenantItem = await sharedItem(
        tenantMarker,
        readersOf(
          // As the system may write it: the tenant in capitals.
          {
            kind: "tenant",
            provider: "microsoft",
            tenant: acmeTenant.toUpperCase(),
          },
          { kind: "tenant", provider: "google", tenant: "acme.test" }
        )
      );
      const elsewhereMarker = uniqueWord();
      const elsewhere = await sharedItem(
        elsewhereMarker,
        readersOf(
          {
            kind: "group",
            provider: "microsoft",
            tenant: acmeTenant,
            group: `group-${unique()}`,
          },
          // Their object ID, but as a Google account's: another system's.
          {
            kind: "account",
            provider: "google",
            tenant: "acme.test",
            account: member.oid,
          },
          // Another tenant's everyone.
          { kind: "tenant", provider: "microsoft", tenant: otherTenant }
        )
      );

      expect({
        member: await finds(member.userId, tenantItem, tenantMarker),
        googleMember: await finds(googleMember, tenantItem, tenantMarker),
        asTheirTeams: await finds(
          member.userId,
          tenantItem,
          tenantMarker,
          false
        ),
        elsewhere: await finds(member.userId, elsewhere, elsewhereMarker),
      }).toStrictEqual({
        member: true,
        googleMember: true,
        asTheirTeams: false,
        elsewhere: false,
      });
    }
  );

  it(
    "names a Google account by its verified address in any case or Unicode form, never by an unverified one or one outside the company's domains",
    setUpTime,
    async () => {
      // Signed in with Google as "zoë", decomposed: "e" and a combining
      // diaeresis, as some systems write it.
      const local = `zoe\u0308-${unique()}`;
      const zoe = await whoami(
        await signedIn(
          idp,
          "google",
          googlePerson({ email: `${local}@acme.test` })
        )
      );
      // Signed in with Microsoft: Entra's address is never verified.
      const entra = await microsoftMember();
      const marker = uniqueWord();
      const source = await sharedItem(
        marker,
        readersOf(
          // As a list may write it: composed, in capitals.
          {
            kind: "account",
            provider: "google",
            tenant: "ACME.TEST",
            account: `${local.normalize("NFC").toUpperCase()}@ACME.TEST`,
          },
          {
            kind: "account",
            provider: "microsoft",
            tenant: acmeTenant,
            account: entra.email,
          },
          {
            kind: "account",
            provider: "google",
            tenant: "acme.test",
            account: entra.email,
          }
        )
      );
      const findsWith = async (coreEnv: Env, userId: string) => {
        const { items } = await recallAs(coreEnv, userId, {
          personal: true,
          question: marker,
          budget: { tokens: recallBudgetMax },
        });
        return items.some(({ source: found }) => found.id === source.id);
      };

      expect({
        zoe: await findsWith(env, zoe.userId),
        entra: await findsWith(env, entra.userId),
        // The same address once the company's sign-in no longer has its
        // domain: it counts for nothing.
        zoeOutsideDomains: await findsWith(
          withSignIn({ domains: ["elsewhere.test"] }),
          zoe.userId
        ),
      }).toStrictEqual({ zoe: true, entra: false, zoeOutsideDomains: false });
    }
  );

  it(
    "keeps no address or object ID in the Brain or its exports, forgets them at an erasure, and gives a new person with the same address only what is shared with them after",
    setUpTime,
    async () => {
      const admin = await signedInApi(idp, "admin");
      const local = `leaver-${unique()}`;
      const address = `${local}@acme.test`;
      const leaverClaims = googlePerson({ email: address });
      const leaver = await whoami(await signedIn(idp, "google", leaverClaims));
      const colleague = await microsoftMember();
      const googleReader: SourceReader = {
        kind: "account",
        provider: "google",
        tenant: "acme.test",
        account: address,
      };
      const oldMarker = uniqueWord();
      const old = await sharedItem(
        oldMarker,
        readersOf(googleReader, colleague.account)
      );
      const leaverRead = await finds(leaver.userId, old, oldMarker);
      // A company export, written whole, while the list names them.
      const shared = brainOf(inJurisdiction(env, env.BRAIN_STORE));
      const { id: exportId } = await shared.startExport("test");
      for (let tick = 0; tick < 20; tick += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one tick at a time
        const status = await shared.exportStatus({ id: exportId });
        if (status?.state !== "writing") {
          break;
        }
        // oxlint-disable-next-line no-await-in-loop -- one tick at a time
        await workBrain(env, new Date(), noProducers);
      }
      const exportedStatus = await shared.exportStatus({ id: exportId });
      const exported = exportedStatus?.state;
      const traces = [local, colleague.oid, String(leaverClaims.sub)];
      const heldBefore = {
        tables: await tablesHolding(traces),
        objects: await objectsHolding(traces),
      };

      await admin.api.members.remove(leaver.userId);
      await admin.api.members.erase(leaver.userId, String(leaverClaims.name));
      await runMinuteTasks();
      const tokensHeld = await tokensHold(local);
      // Someone new, given the same address.
      const newcomer = { userId: await newcomerAt(admin, address) };
      const laterMarker = uniqueWord();
      const later = await sharedItem(laterMarker, readersOf(googleReader));

      expect({
        leaverRead,
        exported,
        heldBefore,
        tokensHeld,
        newcomerOld: await finds(newcomer.userId, old, oldMarker),
        newcomerLater: await finds(newcomer.userId, later, laterMarker),
        colleagueOld: await finds(colleague.userId, old, oldMarker),
      }).toStrictEqual({
        leaverRead: true,
        exported: "done",
        heldBefore: { tables: [], objects: [] },
        tokensHeld: false,
        newcomerOld: false,
        newcomerLater: true,
        colleagueOld: true,
      });
    }
  );

  it(
    "forgets a person's tokens though the Brain held their erasure up, connect's part waiting for it, and though Google's sign-in was turned off since",
    setUpTime,
    async () => {
      const admin = await signedInApi(idp, "admin");
      // Signed in with Microsoft, with their own Google connected: they
      // read what is shared with that Google account.
      const connector = await microsoftMember();
      const { account: connectorsGoogle } = await connectedGoogle(connector);
      // Signed in with Google, and never reads what is shared with them.
      const googleLocal = `goer-${unique()}`;
      const googleClaims = googlePerson({ email: `${googleLocal}@acme.test` });
      const googleMember = await whoami(
        await signedIn(idp, "google", googleClaims)
      );
      const marker = uniqueWord();
      const list = await sharedItem(
        marker,
        readersOf(connectorsGoogle, {
          kind: "account",
          provider: "google",
          tenant: "acme.test",
          account: String(googleClaims.email),
        })
      );
      const connectorRead = await finds(connector.userId, list, marker);
      // The Brain's part fails at first: what waits for it waits, connect's
      // part among it, as it keeps the accounts that part forgets.
      await holdingBrainErasures(true);
      let meanwhile: string[] = [];
      try {
        for (const { userId, name } of [
          { userId: connector.userId, name: connector.name },
          { userId: googleMember.userId, name: String(googleClaims.name) },
        ]) {
          // oxlint-disable-next-line no-await-in-loop -- one person at a time
          await admin.api.members.remove(userId);
          // oxlint-disable-next-line no-await-in-loop -- one person at a time
          await outcome(admin.api.members.erase(userId, name));
        }
        await runMinuteTasks();
        const { erasure } = await admin.api.members.erasure(connector.userId);
        meanwhile = (erasure?.areas ?? [])
          .filter(({ area }) => area === "connect" || area === "identity")
          .map(({ area, state }) => `${area} ${state}`)
          .toSorted();
      } finally {
        await holdingBrainErasures(false);
      }
      // Then Google's sign-in is turned off, and the erasure finishes.
      await runMinuteTasks({
        SIGN_IN: withSignIn({ google: undefined }).SIGN_IN,
      });
      const areas = await Promise.all(
        [connector.userId, googleMember.userId].map(async (userId) => {
          const { erasure } = await admin.api.members.erasure(userId);
          return erasure?.areas.every(({ state }) => state === "complete");
        })
      );
      // Whoever is given their addresses later reads nothing of the list.
      const newcomers = [
        await newcomerAt(admin, connector.email),
        await newcomerAt(admin, String(googleClaims.email)),
      ];

      expect({
        connectorRead,
        meanwhile,
        areas,
        newcomersRead: await Promise.all(
          newcomers.map(async (userId) => await finds(userId, list, marker))
        ),
        tokensHold: [
          await tokensHold(connector.email),
          await tokensHold(googleLocal),
          await tokensHold(connector.oid),
        ],
      }).toStrictEqual({
        connectorRead: true,
        meanwhile: ["connect pending", "identity pending"],
        areas: [true, true],
        newcomersRead: [false, false],
        tokensHold: [false, false, false],
      });
    }
  );

  it(
    "keeps the token a colleague holds when an erased person's stored address was theirs before",
    setUpTime,
    async () => {
      const admin = await signedInApi(idp, "admin");
      const colleagueAddress = `kept-${unique()}@acme.test`;
      // Signed in with Google once under the address that is now the
      // colleague's: their account keeps it, stale.
      const leaverClaims = googlePerson();
      const leaver = await whoami(await signedIn(idp, "google", leaverClaims));
      await env.DB.prepare(
        "UPDATE accounts SET verified_email = ? WHERE user_id = ?"
      )
        .bind(colleagueAddress, leaver.userId)
        .run();
      const colleague = await whoami(
        await signedIn(idp, "google", googlePerson({ email: colleagueAddress }))
      );
      const marker = uniqueWord();
      const list = await sharedItem(
        marker,
        readersOf({
          kind: "account",
          provider: "google",
          tenant: "acme.test",
          account: colleagueAddress,
        })
      );
      const before = await finds(colleague.userId, list, marker);
      await admin.api.members.remove(leaver.userId);
      await admin.api.members.erase(leaver.userId, String(leaverClaims.name));
      await runMinuteTasks();

      expect({
        before,
        after: await finds(colleague.userId, list, marker),
      }).toStrictEqual({ before: true, after: true });
    }
  );

  it(
    "keeps a list of 250 readers whose one member here reads it",
    setUpTime,
    async () => {
      const member = await microsoftMember();
      const marker = uniqueWord();
      const source = await sharedItem(
        marker,
        readersOf(
          ...Array.from({ length: 249 }, (): SourceReader => ({
            kind: "account",
            provider: "google",
            tenant: "acme.test",
            account: `someone-${unique()}@acme.test`,
          })),
          member.account
        )
      );

      await expect(finds(member.userId, source, marker)).resolves.toBeTruthy();
    }
  );

  it(
    "counts a sign-in only in the tenant it proved, and in a tenant the config moves to only once signed in through it",
    setUpTime,
    async () => {
      const claims = entraPerson(acmeTenant);
      const { userId } = await whoami(
        await signedIn(idp, "microsoft", claims, {
          coreEnv: withSignIn({ admins: [claims.email] }),
        })
      );
      const accountMarker = uniqueWord();
      const byAccount = await sharedItem(
        accountMarker,
        readersOf({
          kind: "account",
          provider: "microsoft",
          tenant: acmeTenant,
          account: String(claims.oid),
        })
      );
      const tenantMarker = uniqueWord();
      const byTenant = await sharedItem(
        tenantMarker,
        readersOf({
          kind: "tenant",
          provider: "microsoft",
          tenant: otherTenant,
        })
      );
      const movedEnv = withSignIn({
        entra: { tenantId: otherTenant, clientId: entraClient.id },
      });
      const findsWith = async (
        coreEnv: Env,
        source: SourceRef,
        marker: string
      ) => {
        const { items } = await recallAs(coreEnv, userId, {
          personal: true,
          question: marker,
          budget: { tokens: recallBudgetMax },
        });
        return items.some(({ source: found }) => found.id === source.id);
      };
      const before = await findsWith(env, byAccount, accountMarker);
      // The config moves to another tenant: their sign-in proved the first.
      const moved = {
        account: await findsWith(movedEnv, byAccount, accountMarker),
        tenant: await findsWith(movedEnv, byTenant, tenantMarker),
      };
      // Signed in through the new tenant, the same account.
      await signedIn(
        idp,
        "microsoft",
        { ...claims, tid: otherTenant },
        { coreEnv: movedEnv }
      );

      expect({
        before,
        moved,
        signedIn: {
          account: await findsWith(movedEnv, byAccount, accountMarker),
          tenant: await findsWith(movedEnv, byTenant, tenantMarker),
        },
      }).toStrictEqual({
        before: true,
        moved: { account: false, tenant: false },
        signedIn: { account: true, tenant: true },
      });
    }
  );

  it(
    "forgets the token of a Google account a person connected under another address than they sign in with, though they never read by it",
    setUpTime,
    async () => {
      const admin = await signedInApi(idp, "admin");
      // Signed in with Google; their account's address has changed since,
      // so the connection Google gives them carries the new one.
      const claims = googlePerson();
      const session = await signedIn(idp, "google", claims);
      const { userId } = await whoami(session);
      const renamed = `${String(claims.sub)}@acme.test`;
      const marker = uniqueWord();
      const list = await sharedItem(
        marker,
        readersOf({
          kind: "account",
          provider: "google",
          tenant: "acme.test",
          account: renamed,
        })
      );
      await connectedGoogle({ session, email: renamed });
      await admin.api.members.remove(userId);
      await admin.api.members.erase(userId, String(claims.name));
      await runMinuteTasks();
      // Someone new, given the address their account had changed to.
      const { userId: newcomer } = await whoami(
        await signedIn(idp, "google", googlePerson({ email: renamed }))
      );

      await expect(finds(newcomer, list, marker)).resolves.toBeFalsy();
    }
  );

  it(
    "stops counting a connected Google address once a renewal confirms another, and counts the new one",
    setUpTime,
    async () => {
      const alice = await microsoftMember();
      const { id: connectionId, account: oldAddress } =
        await connectedGoogle(alice);
      // Shared with the address her connection was made under, which an
      // admin then gives someone new.
      const oldMarker = uniqueWord();
      const sharedWithOld = await sharedItem(oldMarker, readersOf(oldAddress));
      const before = await finds(alice.userId, sharedWithOld, oldMarker);
      const [local = ""] = alice.email.split("@");
      const renamed = `${local}-renamed@acme.test`;
      await googleGives(local, renamed);
      await renewed(connectionId);
      const newMarker = uniqueWord();
      const sharedWithNew = await sharedItem(
        newMarker,
        readersOf({
          kind: "account",
          provider: "google",
          tenant: "acme.test",
          account: renamed,
        })
      );

      expect({
        before,
        afterOld: await finds(alice.userId, sharedWithOld, oldMarker),
        afterNew: await finds(alice.userId, sharedWithNew, newMarker),
      }).toStrictEqual({ before: true, afterOld: false, afterNew: true });
    }
  );

  it(
    "counts no connected Google address a renewal couldn't confirm",
    setUpTime,
    async () => {
      const alice = await microsoftMember();
      const { id: connectionId, account } = await connectedGoogle(alice);
      const marker = uniqueWord();
      const shared = await sharedItem(marker, readersOf(account));
      const before = await finds(alice.userId, shared, marker);
      const [local = ""] = alice.email.split("@");
      // Renewed with no ID token, and no userinfo answer.
      await googleGives(local, null);
      await renewed(connectionId);

      expect({
        before,
        after: await finds(alice.userId, shared, marker),
      }).toStrictEqual({ before: true, after: false });
    }
  );

  it(
    "counts a Google sign-in only under the hosted domain it proved, and under one the config moves to only once signed in through it",
    setUpTime,
    async () => {
      const claims = googlePerson();
      const { userId } = await whoami(await signedIn(idp, "google", claims));
      const accountMarker = uniqueWord();
      const byAccount = await sharedItem(
        accountMarker,
        readersOf({
          kind: "account",
          provider: "google",
          tenant: "acme.test",
          account: String(claims.email),
        })
      );
      const tenantMarker = uniqueWord();
      const byTenant = await sharedItem(
        tenantMarker,
        readersOf({
          kind: "tenant",
          provider: "google",
          tenant: "elsewhere.test",
        })
      );
      const movedEnv = withSignIn({
        google: { hostedDomain: "elsewhere.test", clientId: googleClient.id },
      });
      const findsWith = async (
        coreEnv: Env,
        source: SourceRef,
        marker: string
      ) => {
        const { items } = await recallAs(coreEnv, userId, {
          personal: true,
          question: marker,
          budget: { tokens: recallBudgetMax },
        });
        return items.some(({ source: found }) => found.id === source.id);
      };
      const before = await findsWith(env, byAccount, accountMarker);
      const moved = {
        account: await findsWith(movedEnv, byAccount, accountMarker),
        tenant: await findsWith(movedEnv, byTenant, tenantMarker),
      };
      // Signed in through the new hosted domain, the same account.
      await signedIn(
        idp,
        "google",
        { ...claims, hd: "elsewhere.test" },
        { coreEnv: movedEnv }
      );

      expect({
        before,
        moved,
        signedIn: {
          account: await findsWith(movedEnv, byAccount, accountMarker),
          tenant: await findsWith(movedEnv, byTenant, tenantMarker),
        },
      }).toStrictEqual({
        before: true,
        moved: { account: false, tenant: false },
        signedIn: { account: true, tenant: true },
      });
    }
  );

  it(
    "stops counting an idle connection's address a day after it was last confirmed",
    setUpTime,
    async () => {
      // Alice's connection, used by nothing: her address is given to a new
      // hire, and files shared with the new hire name it.
      const alice = await microsoftMember();
      const { account: address } = await connectedGoogle(alice);
      const marker = uniqueWord();
      const newHiresFile = await sharedItem(marker, readersOf(address));

      expect({
        now: await finds(alice.userId, newHiresFile, marker),
        withinTheDay: await findsLater(
          dayMs - hourMs,
          alice.userId,
          newHiresFile,
          marker
        ),
        afterADay: await findsLater(
          dayMs + hourMs,
          alice.userId,
          newHiresFile,
          marker
        ),
      }).toStrictEqual({ now: true, withinTheDay: true, afterADay: false });
    }
  );

  it(
    "claims by a new connection only the addresses it proves now: a colleague given an idle connection's address still reads after its owner's erasure",
    setUpTime,
    async () => {
      const admin = await signedInApi(idp, "admin");
      // Alice's connected Google account was renamed to an address that
      // has since moved to Bob; her connection last confirmed it over a
      // day ago. A file shared with Bob names it, and he reads it.
      const alice = await microsoftMember();
      const { id: idle } = await connectedGoogle(alice);
      const [local = ""] = alice.email.split("@");
      const moved = `moved-${unique()}@acme.test`;
      await googleGives(local, moved);
      await renewedOnly(idle);
      await connectDb()
        .prepare("UPDATE connections SET verified_email_at = ? WHERE id = ?")
        .bind(Date.now() - 25 * hourMs, idle)
        .run();
      const { userId: bob } = await whoami(
        await signedIn(idp, "google", googlePerson({ email: moved }))
      );
      const marker = uniqueWord();
      const bobsFile = await sharedItem(
        marker,
        readersOf({
          kind: "account",
          provider: "google",
          tenant: "acme.test",
          account: moved,
        })
      );
      const before = await finds(bob, bobsFile, marker);
      // Then Alice connects her own Microsoft account, proved now.
      await connectedMicrosoft(alice);
      const claimed = await tokensClaimedBy(alice.userId);
      await erasedBy(admin, alice);

      // Alice claimed her first Google address, when she connected it, and
      // her Microsoft account; not the address Bob holds.
      expect({
        before,
        claimedByAlice: claimed,
        after: await finds(bob, bobsFile, marker),
      }).toStrictEqual({ before: true, claimedByAlice: 2, after: true });
    }
  );

  it(
    "stops counting the address of a connection needing reconnecting a day after it was last confirmed",
    setUpTime,
    async () => {
      const alice = await microsoftMember();
      const { id: connectionId, account: address } =
        await connectedGoogle(alice);
      await connectDb()
        .prepare("UPDATE connections SET status = 'needs_reauth' WHERE id = ?")
        .bind(connectionId)
        .run();
      const marker = uniqueWord();
      const shared = await sharedItem(marker, readersOf(address));

      expect({
        now: await finds(alice.userId, shared, marker),
        afterADay: await findsLater(
          dayMs + hourMs,
          alice.userId,
          shared,
          marker
        ),
      }).toStrictEqual({ now: true, afterADay: false });
    }
  );

  it(
    "keeps counting a connection's address a renewal inside the day confirms again",
    setUpTime,
    async () => {
      const alice = await microsoftMember();
      const { id: connectionId, account: address } =
        await connectedGoogle(alice);
      // Last confirmed 23 hours ago.
      await connectDb()
        .prepare("UPDATE connections SET verified_email_at = ? WHERE id = ?")
        .bind(Date.now() - 23 * hourMs, connectionId)
        .run();
      const marker = uniqueWord();
      const shared = await sharedItem(marker, readersOf(address));
      const unrenewed = await findsLater(
        2 * hourMs,
        alice.userId,
        shared,
        marker
      );
      await renewed(connectionId);

      expect({
        unrenewed,
        renewed: await findsLater(2 * hourMs, alice.userId, shared, marker),
      }).toStrictEqual({ unrenewed: false, renewed: true });
    }
  );

  it(
    "forgets the token of the address a renewal confirmed, though the person is erased before the drain and never read by it",
    setUpTime,
    async () => {
      const admin = await signedInApi(idp, "admin");
      const alice = await microsoftMember();
      const { id: connectionId } = await connectedGoogle(alice);
      const [local = ""] = alice.email.split("@");
      const renamed = `${local}-renamed@acme.test`;
      // Shared with the address before it was hers.
      const marker = uniqueWord();
      const list = await sharedItem(
        marker,
        readersOf({
          kind: "account",
          provider: "google",
          tenant: "acme.test",
          account: renamed,
        })
      );
      await googleGives(local, renamed);
      // Renewed, then removed and erased before the clock drains it.
      await renewedOnly(connectionId);
      await admin.api.members.remove(alice.userId);
      await admin.api.members.erase(alice.userId, alice.name);
      await runMinuteTasks();
      const { userId: newcomer } = await whoami(
        await signedIn(idp, "google", googlePerson({ email: renamed }))
      );

      await expect(finds(newcomer, list, marker)).resolves.toBeFalsy();
    }
  );

  it(
    "counts a Google sign-in's address for a day after the sign-in confirmed it, also in a direct-message turn, and again after a new sign-in",
    setUpTime,
    async () => {
      // Bob signs in once, then uses Grasp only through Slack; his address
      // is then given to a new hire, and files shared with them name it.
      const admin = await signedInApi(idp, "admin");
      const bobClaims = googlePerson();
      const { userId: bob } = await whoami(
        await signedIn(idp, "google", bobClaims)
      );
      const [topic, secret] = [uniqueWord(), uniqueWord()];
      await sharedItem(
        `${topic} ${secret}`,
        readersOf({
          kind: "account",
          provider: "google",
          tenant: "acme.test",
          account: String(bobClaims.email),
        })
      );
      await signInConfirmedAgo(bob, 23 * hourMs);
      const at23 = await findsInDirectMessage(admin, bob, topic, secret);
      await signInConfirmedAgo(bob, 25 * hourMs);
      const at25 = await findsInDirectMessage(admin, bob, topic, secret);
      await signedIn(idp, "google", bobClaims);

      expect({
        at23,
        at25,
        signedInAgain: await findsInDirectMessage(admin, bob, topic, secret),
      }).toStrictEqual({ at23: true, at25: false, signedInAgain: true });
    }
  );

  it(
    "keeps counting the Google address of a person whose connected account confirmed it, though their sign-in's proof lapsed",
    setUpTime,
    async () => {
      const admin = await signedInApi(idp, "admin");
      const local = `syncs-${unique()}`;
      const claims = googlePerson({ sub: local, email: `${local}@acme.test` });
      const session = await signedIn(idp, "google", claims);
      const { userId } = await whoami(session);
      // Their own Google account, connected: the sync keeps it confirmed.
      await connectedGoogle({ session, email: String(claims.email) });
      const [topic, secret] = [uniqueWord(), uniqueWord()];
      await sharedItem(
        `${topic} ${secret}`,
        readersOf({
          kind: "account",
          provider: "google",
          tenant: "acme.test",
          account: String(claims.email),
        })
      );
      await signInConfirmedAgo(userId, 25 * hourMs);

      await expect(
        findsInDirectMessage(admin, userId, topic, secret)
      ).resolves.toBeTruthy();
    }
  );

  it(
    "forgets the token of an address a connection confirmed and then lost, though the person never read by it",
    setUpTime,
    async () => {
      const admin = await signedInApi(idp, "admin");
      const alice = await microsoftMember();
      const { id: connectionId } = await connectedGoogle(alice);
      const [local = ""] = alice.email.split("@");
      const [renamed, renamedAgain] = [
        `${local}-b@acme.test`,
        `${local}-c@acme.test`,
      ];
      // Renamed to B, then a list names B; renamed again to C, and
      // another to whom the cleared case leaves no address at all.
      await googleGives(local, renamed);
      await renewed(connectionId);
      const marker = uniqueWord();
      const list = await sharedItem(
        marker,
        readersOf({
          kind: "account",
          provider: "google",
          tenant: "acme.test",
          account: renamed,
        })
      );
      await googleGives(local, renamedAgain);
      await renewed(connectionId);
      await admin.api.members.remove(alice.userId);
      await admin.api.members.erase(alice.userId, alice.name);
      await runMinuteTasks();
      const { userId: newcomer } = await whoami(
        await signedIn(idp, "google", googlePerson({ email: renamed }))
      );

      await expect(finds(newcomer, list, marker)).resolves.toBeFalsy();
    }
  );

  it(
    "forgets the token of an address a connection confirmed before a renewal couldn't confirm any",
    setUpTime,
    async () => {
      const admin = await signedInApi(idp, "admin");
      const alice = await microsoftMember();
      const { id: connectionId } = await connectedGoogle(alice);
      const [local = ""] = alice.email.split("@");
      const renamed = `${local}-b@acme.test`;
      await googleGives(local, renamed);
      await renewed(connectionId);
      const marker = uniqueWord();
      const list = await sharedItem(
        marker,
        readersOf({
          kind: "account",
          provider: "google",
          tenant: "acme.test",
          account: renamed,
        })
      );
      await googleGives(local, null);
      await renewed(connectionId);
      await admin.api.members.remove(alice.userId);
      await admin.api.members.erase(alice.userId, alice.name);
      await runMinuteTasks();
      const { userId: newcomer } = await whoami(
        await signedIn(idp, "google", googlePerson({ email: renamed }))
      );

      await expect(finds(newcomer, list, marker)).resolves.toBeFalsy();
    }
  );

  it(
    "forgets the tokens of every address a person signed in with, though they never read by them",
    setUpTime,
    async () => {
      const admin = await signedInApi(idp, "admin");
      const local = `signs-${unique()}`;
      const [first, second, third] = [
        `${local}-a@acme.test`,
        `${local}-b@acme.test`,
        `${local}-c@acme.test`,
      ];
      const claims = googlePerson({ email: first });
      const { userId } = await whoami(await signedIn(idp, "google", claims));
      const markers = [uniqueWord(), uniqueWord()];
      const lists = await Promise.all(
        [first, second].map(
          async (address, index) =>
            await sharedItem(
              markers[index] ?? "",
              readersOf({
                kind: "account",
                provider: "google",
                tenant: "acme.test",
                account: address,
              })
            )
        )
      );
      // Their Google account renamed twice, each time signed in again.
      await signedIn(idp, "google", { ...claims, email: second });
      await signedIn(idp, "google", { ...claims, email: third });
      await admin.api.members.remove(userId);
      await admin.api.members.erase(userId, String(claims.name));
      await runMinuteTasks();
      await admin.api.members.releaseAddress(first);
      const signedInAt = async (address: string): Promise<string> => {
        const { userId: newcomer } = await whoami(
          await signedIn(idp, "google", googlePerson({ email: address }))
        );
        return newcomer;
      };
      const [firstList, secondList] = lists;
      const [firstMarker = "", secondMarker = ""] = markers;
      if (firstList === undefined || secondList === undefined) {
        throw new Error("Expected two lists");
      }
      const atFirst = await signedInAt(first);
      const atSecond = await signedInAt(second);

      expect({
        first: await finds(atFirst, firstList, firstMarker),
        second: await finds(atSecond, secondList, secondMarker),
      }).toStrictEqual({ first: false, second: false });
    }
  );

  it(
    "stops a person's connections before the erasure reads their addresses, though a failed removal left them connected",
    setUpTime,
    async () => {
      const admin = await signedInApi(idp, "admin");
      const alice = await microsoftMember();
      const { id: connectionId } = await connectedGoogle(alice);
      const [local = ""] = alice.email.split("@");
      // The removal's disconnect fails: her connection stays connected.
      const { core: down } = await openRpc(admin.session, {
        coreEnv: { ...env, CONNECT: connectFailing("disconnectPersonal") },
      });
      const removed = await outcome(
        down.authenticate().members.remove(alice.userId)
      );
      // The erasure starts; connect's own part fails for now, so what
      // `identity` read is all that stands between them.
      const { core: erasing } = await openRpc(admin.session, {
        coreEnv: { ...env, CONNECT: connectFailing("erasePersonal") },
      });
      await outcome(
        erasing.authenticate().members.erase(alice.userId, alice.name)
      );
      const afterIdentity = await env.CONNECT.personalAccounts(alice.userId);
      // Google renames her account; a renewal tries to confirm it.
      await googleGives(local, `${local}-b@acme.test`);
      await renewedOnly(connectionId);
      const afterRenewal = await env.CONNECT.personalAccounts(alice.userId);

      expect({
        removed,
        afterIdentity: afterIdentity.map(({ connected }) => connected),
        afterRenewal: afterRenewal.map(({ verifiedEmail }) => verifiedEmail),
      }).toStrictEqual({
        removed: "member.connections_pending",
        afterIdentity: [false],
        afterRenewal: [alice.email],
      });
    }
  );

  it(
    "keeps each address a connection lost once, however often it comes back",
    setUpTime,
    async () => {
      const alice = await microsoftMember();
      const { id: connectionId } = await connectedGoogle(alice);
      const [local = ""] = alice.email.split("@");
      const renamed = `${local}-b@acme.test`;
      for (const address of [renamed, alice.email, renamed]) {
        // oxlint-disable-next-line no-await-in-loop -- one renewal at a time
        await googleGives(local, address);
        // oxlint-disable-next-line no-await-in-loop -- one renewal at a time
        await renewed(connectionId);
      }
      const [account] = await env.CONNECT.personalAccounts(alice.userId);

      expect({
        now: account?.verifiedEmail,
        past: account?.pastVerifiedEmails,
      }).toStrictEqual({ now: renamed, past: [alice.email, renamed] });
    }
  );

  it(
    "reads a person's addresses only once their connections can write none: a renewal right after the read confirms nothing",
    setUpTime,
    async () => {
      const admin = await signedInApi(idp, "admin");
      const alice = await microsoftMember();
      const { id: connectionId } = await connectedGoogle(alice);
      const [local = ""] = alice.email.split("@");
      // Her removal's disconnect fails: her connection stays connected.
      const { core: down } = await openRpc(admin.session, {
        coreEnv: { ...env, CONNECT: connectFailing("disconnectPersonal") },
      });
      await outcome(down.authenticate().members.remove(alice.userId));
      // Connect answers the erasure's read of her accounts, and then, at
      // once, a renewal tries to confirm B; its own erasure fails for now,
      // so what the read left is what stays.
      const racing = new Proxy(env.CONNECT, {
        get: (target, key) => {
          if (key === "personalAccounts") {
            return async (userId: string) => {
              const read = await target.personalAccounts(userId);
              await googleGives(local, `${local}-b@acme.test`);
              await renewedOnly(connectionId);
              return read;
            };
          }
          if (key === "erasePersonal") {
            return () => {
              throw new Error("connect unreachable");
            };
          }
          const value: unknown = Reflect.get(target, key);
          return value;
        },
      });
      const { core } = await openRpc(admin.session, {
        coreEnv: { ...env, CONNECT: racing },
      });
      await outcome(
        core.authenticate().members.erase(alice.userId, alice.name)
      );
      const after = await env.CONNECT.personalAccounts(alice.userId);

      expect(
        after.map(({ connected, verifiedEmail }) => ({
          connected,
          verifiedEmail,
        }))
      ).toStrictEqual([{ connected: false, verifiedEmail: alice.email }]);
    }
  );

  it(
    "writes no connection a callback finishes after the erasure began, for an account renamed A to B, and claims no token",
    setUpTime,
    async () => {
      const admin = await signedInApi(idp, "admin");
      // Signed in with Google as A; the same account is renamed B, which a
      // connection flow under way will be told.
      const subject = `renamed-${unique()}`;
      const claims = googlePerson({
        sub: subject,
        email: `first-${unique()}@acme.test`,
      });
      const session = await signedIn(idp, "google", claims);
      const { userId: alice } = await whoami(session);
      const { core } = await openRpc(session);
      const { url } = await core.authenticate().connections.start({
        provider: "google",
        scope: "personal",
        returnTo: "/integrations",
      });
      const flow = new URL(url);
      // Her callback gets past Google's code exchange, and waits before
      // connect stores the connection.
      await fakeGoogle(googleHoldUrl, {
        method: "POST",
        body: JSON.stringify({ hold: true }),
      });
      const finishing = backFromProvider(session, {
        code: consentCode(
          flow,
          "acme.test",
          subject,
          flow.searchParams.get("scope") ?? ""
        ),
        state: flow.searchParams.get("state") ?? "",
      }).then(
        () => "connected",
        () => "refused"
      );
      try {
        await exchangeHeld();
        // Meanwhile she is removed and erased; connect's own part of the
        // erasure fails for now.
        await admin.api.members.remove(alice);
        const { core: erasing } = await openRpc(admin.session, {
          coreEnv: { ...env, CONNECT: connectFailing("erasePersonal") },
        });
        await outcome(
          erasing.authenticate().members.erase(alice, String(claims.name))
        );
      } finally {
        await fakeGoogle(googleHoldUrl, {
          method: "POST",
          body: JSON.stringify({ hold: false }),
        });
      }
      const finished = await finishing;

      expect({
        finished,
        connections: await env.CONNECT.personalAccounts(alice),
        claimed: await tokensClaimedBy(alice),
      }).toStrictEqual({ finished: "refused", connections: [], claimed: 0 });
    }
  );

  // Every write naming a person, or an address or account of theirs,
  // computed before their erasure began and run after it: none lands.
  // One each, the same shape: the write's inputs, then the erasure, then
  // the write (source-readers.ts `erasureBegan`).

  it(
    "claims no token for an erased person by the accounts a connection callback read before",
    setUpTime,
    async () => {
      const admin = await signedInApi(idp, "admin");
      const alice = await microsoftMember();
      await connectedGoogle(alice);
      const read = await env.CONNECT.personalAccounts(alice.userId);
      await erasedBy(admin, alice);
      await claimConnectedTokens(env, alice.userId, read);

      await expect(tokensClaimedBy(alice.userId)).resolves.toBe(0);
    }
  );

  it(
    "claims no token for an erased person at a read by the accounts it read before",
    setUpTime,
    async () => {
      const admin = await signedInApi(idp, "admin");
      const alice = await microsoftMember();
      await connectedMicrosoft(alice);
      const read = await env.CONNECT.personalAccounts(alice.userId);
      await erasedBy(admin, alice);
      // A list copied since names her account: its token, nobody's.
      await sharedItem(uniqueWord(), readersOf(alice.account));
      await heldPrincipalsOf(env, alice.userId, [], read);

      await expect(tokensClaimedBy(alice.userId)).resolves.toBe(0);
    }
  );

  it("keeps no sign-in address for an erased person", setUpTime, async () => {
    const admin = await signedInApi(idp, "admin");
    const claims = googlePerson();
    const { userId } = await whoami(await signedIn(idp, "google", claims));
    await erasedBy(admin, { userId, name: String(claims.name) });
    await keepSignInAddress(env, userId, String(claims.email));
    const kept = await env.DB.prepare(
      "SELECT count(*) AS n FROM sign_in_addresses WHERE user_id = ?"
    )
      .bind(userId)
      .first<{ n: number }>();

    expect(kept?.n).toBe(0);
  });

  it(
    "makes or changes no sign-in account of a person whose erasure began",
    setUpTime,
    async () => {
      const admin = await signedInApi(idp, "admin");
      const claims = googlePerson();
      const { userId } = await whoami(await signedIn(idp, "google", claims));
      const later = `later-${unique()}@acme.test`;
      // Their erasure waits on the Brain, so their accounts are still there.
      await holdingBrainErasures(true);
      try {
        await admin.api.members.remove(userId);
        await admin.api.members.erase(userId, String(claims.name));
        const changed = await outcome(
          env.DB.prepare(
            "UPDATE accounts SET verified_email = ?, verified_email_at = ? WHERE user_id = ?"
          )
            .bind(later, Date.now(), userId)
            .run()
        );
        const made = await outcome(
          env.DB.prepare(
            "INSERT INTO accounts (id, account_id, provider_id, user_id, verified_email, created_at, updated_at) VALUES (?, ?, 'google', ?, ?, ?, ?)"
          )
            .bind(
              crypto.randomUUID(),
              `other-${unique()}`,
              userId,
              later,
              Date.now(),
              Date.now()
            )
            .run()
        );
        const { results } = await env.DB.prepare(
          "SELECT verified_email FROM accounts WHERE user_id = ?"
        )
          .bind(userId)
          .all<{ verified_email: string | null }>();

        expect({
          changed: changed === "ok",
          made: made === "ok",
          addresses: results.map(({ verified_email }) => verified_email),
        }).toStrictEqual({
          changed: false,
          made: false,
          addresses: [String(claims.email)],
        });
      } finally {
        await holdingBrainErasures(false);
      }
    }
  );

  it(
    "keeps no address a renewal confirms for a person whose erasure began",
    setUpTime,
    async () => {
      const admin = await signedInApi(idp, "admin");
      const alice = await microsoftMember();
      const { id: connectionId } = await connectedGoogle(alice);
      const [local = ""] = alice.email.split("@");
      await googleGives(local, `${local}-b@acme.test`);
      // A renewal confirming B starts, and waits at Google's token answer.
      await fakeGoogle(googleHoldUrl, {
        method: "POST",
        body: JSON.stringify({
          hold: true,
          prefix: "https://oauth2.googleapis.com/token",
        }),
      });
      const renewing = renewedOnly(connectionId);
      try {
        await exchangeHeld();
        // Her removal's and her erasure's disconnects fail: her connection
        // stays connected, and her erasure has begun.
        const { core: down } = await openRpc(admin.session, {
          coreEnv: { ...env, CONNECT: connectFailing("disconnectPersonal") },
        });
        await outcome(down.authenticate().members.remove(alice.userId));
        await outcome(
          down.authenticate().members.erase(alice.userId, alice.name)
        );
      } finally {
        await fakeGoogle(googleHoldUrl, {
          method: "POST",
          body: JSON.stringify({ hold: false }),
        });
      }
      await renewing;
      const [account] = await env.CONNECT.personalAccounts(alice.userId);

      expect({
        now: account?.verifiedEmail,
        past: account?.pastVerifiedEmails,
      }).toStrictEqual({ now: alice.email, past: [] });
    }
  );

  it(
    "leaves no token naming a person a connection callback claims for after their erasure, from accounts it read before",
    setUpTime,
    async () => {
      const admin = await signedInApi(idp, "admin");
      const alice = await microsoftMember();
      // Her callback finishes in connect and reads her accounts; before
      // core claims by them, she is removed and erased to the end.
      let identity: unknown;
      const late = new Proxy(env.CONNECT, {
        get: (target, key) => {
          if (key === "personalAccounts") {
            return async (userId: string) => {
              const read = await target.personalAccounts(userId);
              await erasedBy(admin, alice);
              identity = await env.DB.prepare(
                "SELECT state FROM person_erasure_areas WHERE user_id = ? AND area = 'identity'"
              )
                .bind(alice.userId)
                .first("state");
              return read;
            };
          }
          const value: unknown = Reflect.get(target, key);
          return value;
        },
      });
      await connectedMicrosoft(alice, { ...env, CONNECT: late });

      expect({
        identity,
        claimed: await tokensClaimedBy(alice.userId),
      }).toStrictEqual({ identity: "complete", claimed: 0 });
    }
  );

  it("refuses a reader's ID that could name another, and other readers for one person's own source", async () => {
    const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
    const colon = await outcome(
      addSource(env, {
        source,
        change: crypto.randomUUID(),
        text: "Lease",
        readers: readersOf({
          kind: "account",
          provider: "google",
          tenant: "acme.test:other",
          account: "1",
        }),
      })
    );
    const owner = await outcome(
      changeSourceReaders(env, {
        source,
        change: crypto.randomUUID(),
        readers: { kind: "owner", personId: "someone" },
      })
    );

    expect({ colon, owner }).toStrictEqual({
      colon: "brain.request_invalid",
      owner:
        "Error: Refused: what one person alone may read is never given other readers",
    });
  });
});
