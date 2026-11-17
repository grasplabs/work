import { recallBudgetMax } from "@grasp-os/brain-next/contract";
import type { SourceReader } from "@grasp-os/shared/source-readers";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  addSource,
  changeSourceReaders,
  readSourceVersionAs,
  recallAs,
} from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant, otherTenant } from "./sign-in-config.ts";
import {
  googlePerson,
  outcome,
  signedIn,
  signedInApi,
  signedInWithRole,
  unique,
  uniqueWord,
  whoami,
} from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

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
  const { userId, person } = await signedInWithRole(idp, "user");
  const account: SourceReader = {
    kind: "account",
    provider: "microsoft",
    tenant: acmeTenant,
    account: String(person.oid),
  };
  return { userId, account, oid: String(person.oid) };
};

/** A Google account `owner` connected as their own, in connect's registry. */
const connectedGoogle = async (
  owner: string,
  status: "active" | "disconnected" = "active"
): Promise<{ id: string; account: SourceReader }> => {
  const id = `connection-google-${unique()}`;
  const sub = `google-sub-${unique()}`;
  const now = Date.now();
  await connectDb()
    .prepare(
      "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, tenant, account_id, created_at, updated_at) VALUES (?, 'google', 'personal', ?, ?, 'native', 'google-workspace', 'acme.test', ?, ?, ?)"
    )
    .bind(id, owner, status, sub, now, now)
    .run();
  return {
    id,
    account: {
      kind: "account",
      provider: "google",
      tenant: "acme.test",
      account: sub,
    },
  };
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
      const { account: connectorsGoogle } = await connectedGoogle(
        connector.userId
      );
      const notListed = await microsoftMember();
      // Listed by a Google account they connected and then disconnected.
      const disconnected = await microsoftMember();
      const { account: disconnectedGoogle } = await connectedGoogle(
        disconnected.userId,
        "disconnected"
      );
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
            account: `google-sub-${unique()}`,
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
        await connectedGoogle(connector.userId);
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
      await connectDb()
        .prepare("UPDATE connections SET status = 'disconnected' WHERE id = ?")
        .bind(connectionId)
        .run();

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
