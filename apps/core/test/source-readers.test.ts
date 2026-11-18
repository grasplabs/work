import { brainOf, recallBudgetMax } from "@grasp-os/brain-next/contract";
import { routerSecretHeader } from "@grasp-os/shared/router";
import type { SourceReader } from "@grasp-os/shared/source-readers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  addSource,
  changeSourceReaders,
  readSourceVersionAs,
  recallAs,
  workBrain,
} from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import worker from "../src/index.ts";
import { objectsHolding, tablesHolding } from "./brain-next-traces.ts";
import { consentCode } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { noProducers } from "./no-producers.ts";
import { acmeTenant, otherTenant } from "./sign-in-config.ts";
import {
  coreOrigin,
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
  };
};

/** The provider's redirect back to core, with `session`, run to its end. */
const backFromProvider = async (
  session: string,
  query: Record<string, string>
): Promise<void> => {
  const headers = new Headers({ cookie: session });
  headers.set(routerSecretHeader, env.ROUTER_SECRET);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(
      `${coreOrigin}/api/connections/callback?${new URLSearchParams(query).toString()}`,
      { redirect: "manual", headers }
    ),
    env,
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
    "reaches the tenant's accounts for a tenant, never through a group, another tenant, or code acting for someone",
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
          // Their object ID, in another tenant.
          {
            kind: "account",
            provider: "microsoft",
            tenant: otherTenant,
            account: member.oid,
          }
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
      const tokensLeft = await env.DB.prepare(
        "SELECT count(*) AS n FROM source_reader_tokens WHERE key LIKE ?"
      )
        .bind(`%${local}%`)
        .first<{ n: number }>();
      await admin.api.members.releaseAddress(address);
      // Someone new, given the same address.
      const newcomer = await whoami(
        await signedIn(idp, "google", googlePerson({ email: address }))
      );
      const laterMarker = uniqueWord();
      const later = await sharedItem(laterMarker, readersOf(googleReader));

      expect({
        leaverRead,
        exported,
        heldBefore,
        tokensLeft: tokensLeft?.n,
        newcomerOld: await finds(newcomer.userId, old, oldMarker),
        newcomerLater: await finds(newcomer.userId, later, laterMarker),
        colleagueOld: await finds(colleague.userId, old, oldMarker),
      }).toStrictEqual({
        leaverRead: true,
        exported: "done",
        heldBefore: { tables: [], objects: [] },
        tokensLeft: 0,
        newcomerOld: false,
        newcomerLater: true,
        colleagueOld: true,
      });
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
