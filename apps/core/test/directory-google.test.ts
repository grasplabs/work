import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { directoryKinds, tieDirectoryPeople } from "../src/directory-ties.ts";
import { landingAt } from "./d1-landing.ts";
import {
  connectedGoogleDirectory,
  googleDeletedRefuses,
  googleDirectoryFailsAt,
  googleDirectoryHolds,
  googleDirectoryRefuses,
  googleDirectoryUser as user,
  googleId,
} from "./directory.ts";
import { mockIdp } from "./idp.ts";
import { runClockTask } from "./maintenance.ts";
import { auditedDuring, googlePerson, signedIn, whoami } from "./sign-in.ts";

// The Google Workspace directory read once a day (GRA-2056, Google's
// slice): everyone the Admin SDK lists, by their Google user ID, tied to
// the member whose Google sign-in named the same ID (its `sub`) in the
// same Workspace (its `hd`). Only Google's Admin SDK is faked; core,
// connect and sign-in are the real ones. Everything after the read is
// Entra's own, tested there.

const idp = mockIdp();
const dayMs = 24 * 60 * 60 * 1000;

let days = 0;
/** A time past every read so far by more than a day: a read is due then. */
const nextDay = (): Date => {
  days += 2;
  return new Date(Date.now() + days * dayMs);
};

/** The clock's daily read, run for the slot at `at`. */
const readAt = async (at: Date, changes: Partial<Env> = {}): Promise<void> => {
  await runClockTask("directory.people", changes, at);
};

/** Someone who signed in with Google under `sub`, in the Workspace, as a member. */
const memberWith = async (sub: string) => {
  const person = googlePerson({ sub });
  const session = await signedIn(idp, "google", person);
  const { userId } = await whoami(session);
  return { sub, userId, name: String(person.name) };
};

interface Row {
  tenant: string;
  id: string;
  department: string;
  enabled: number;
  deleted: number;
  userId: string | null;
}

/** What the read keeps of Google's directory now, by user ID. */
const rows = async (): Promise<Row[]> => {
  const { results } = await env.DB.prepare(
    "SELECT tenant, account_id AS id, department, enabled, deleted, user_id AS userId FROM directory_people WHERE provider = 'google-directory' ORDER BY account_id"
  ).all<Row>();
  return results;
};

/** The row of `id`, if the read keeps one. */
const rowOf = async (id: string): Promise<Row | undefined> => {
  const kept = await rows();
  return kept.find((row) => row.id === id);
};

/** The member the row of `id` is tied to: null for nobody, undefined for no row. */
const tieOf = async (id: string): Promise<string | null | undefined> => {
  const row = await rowOf(id);
  return row?.userId;
};

/** Whether the row of `id` is turned on (1) or off (0); undefined for no row. */
const enabledOf = async (id: string): Promise<number | undefined> => {
  const row = await rowOf(id);
  return row?.enabled;
};

/** How many rows the read keeps of Google's directory. */
const keptCount = async (): Promise<number> => {
  const kept = await rows();
  return kept.length;
};

/** What the read keeps of each row: its ID, and whether it is on and deleted. */
const keptStates = async () => {
  const kept = await rows();
  return kept.map(({ id, enabled, deleted }) => ({ id, enabled, deleted }));
};

/** How the last read of Google's directory went: its failure, and what it counted. */
const status = async () =>
  await env.DB.prepare(
    "SELECT failure, people, disabled FROM directory_reads WHERE provider = 'google-directory'"
  ).first<{
    failure: string | null;
    people: number | null;
    disabled: number | null;
  }>();

/** Why the last read of Google's directory failed; null when it didn't. */
const failureNow = async (): Promise<string | null | undefined> => {
  const now = await status();
  return now?.failure;
};

/** When `userId` was suspended, and by what. */
const suspensionOf = async (userId: string) =>
  await env.DB.prepare(
    "SELECT suspended_at IS NOT NULL AS suspended, suspended_by AS suspendedBy FROM members WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ suspended: number; suspendedBy: string | null }>();

describe("the Google Workspace directory's daily read", () => {
  it("never reads another Workspace's directory, though it lists a member's own ID", async () => {
    // First in this file, before any test connects the deployment's own
    // Workspace: the tests here share their storage. Connected with an
    // account of another Workspace, which the deployment doesn't sign in
    // from.
    await connectedGoogleDirectory(idp, "other.test");
    const ann = await memberWith(googleId());
    await googleDirectoryHolds([user({ id: ann.sub })]);

    await readAt(nextDay());

    expect({ kept: await rows(), status: await status() }).toStrictEqual({
      kept: [],
      status: null,
    });
  });

  it("keeps everyone a read of several pages lists by their Google ID, with the primary organization's department, and ties the member who signed in before it", async () => {
    await connectedGoogleDirectory(idp);
    const ann = await memberWith(googleId());
    const others = Array.from({ length: 229 }, () => user());
    await googleDirectoryHolds([
      ...others.slice(0, 120),
      user({
        id: ann.sub,
        organizations: [
          { department: "Finance", primary: false },
          { department: "Sales", primary: true },
        ],
      }),
      ...others.slice(120),
    ]);

    const events = await auditedDuring(async () => {
      await readAt(nextDay());
    });
    const kept = await rows();

    expect({
      kept: kept.length,
      tenants: [...new Set(kept.map(({ tenant }) => tenant))],
      ann: await rowOf(ann.sub),
      tied: kept.filter(({ userId }) => userId !== null).length,
      status: await status(),
      recorded: events
        .filter(({ action }) => action === "directory.people_read")
        .map(({ detail }) => detail),
    }).toStrictEqual({
      kept: 230,
      tenants: ["acme.test"],
      ann: {
        tenant: "acme.test",
        id: ann.sub,
        department: "Sales",
        enabled: 1,
        deleted: 0,
        userId: ann.userId,
      },
      tied: 1,
      status: { failure: null, people: 230, disabled: 0 },
      recorded: [
        {
          provider: "google-directory",
          people: 230,
          disabled: 0,
          deleted: 0,
          tied: 1,
        },
      ],
    });
  });

  it("takes a joiner, a suspended and an archived account from the next day's read, ties a joiner who signs in after it, and lifts a suspension once the account is active", async () => {
    await connectedGoogleDirectory(idp);
    const [ann, cy] = [
      await memberWith(googleId()),
      await memberWith(googleId()),
    ];
    const bob = googleId();
    await googleDirectoryHolds([user({ id: ann.sub }), user({ id: cy.sub })]);
    await readAt(nextDay());
    await googleDirectoryHolds([
      user({ id: ann.sub, suspended: true }),
      user({ id: bob }),
      user({ id: cy.sub, archived: true }),
    ]);

    await readAt(nextDay());
    const turnedOff = {
      ann: await suspensionOf(ann.userId),
      cy: await suspensionOf(cy.userId),
      annRow: await enabledOf(ann.sub),
      bobRow: await rowOf(bob),
    };
    // Bob signs in after the read: tied there and then, by the read's rule.
    const bobMember = await memberWith(bob);
    const bobTie = await tieOf(bob);
    await googleDirectoryHolds([
      user({ id: ann.sub }),
      user({ id: bob }),
      user({ id: cy.sub, archived: true }),
    ]);
    await readAt(nextDay());

    expect({
      turnedOff,
      bobTie,
      lifted: {
        ann: await suspensionOf(ann.userId),
        cy: await suspensionOf(cy.userId),
      },
    }).toStrictEqual({
      turnedOff: {
        ann: { suspended: 1, suspendedBy: "directory" },
        cy: { suspended: 1, suspendedBy: "directory" },
        annRow: 0,
        bobRow: {
          tenant: "acme.test",
          id: bob,
          department: "",
          enabled: 1,
          deleted: 0,
          userId: null,
        },
      },
      bobTie: bobMember.userId,
      lifted: {
        ann: { suspended: 0, suspendedBy: null },
        cy: { suspended: 1, suspendedBy: "directory" },
      },
    });
  });

  it("changes nothing when a page fails, or when Google refuses a member's token, and says which", async () => {
    await connectedGoogleDirectory(idp);
    const people = Array.from({ length: 150 }, () => user());
    const before = await rows();
    await googleDirectoryHolds(people);
    await googleDirectoryFailsAt(100);
    await readAt(nextDay());
    const failed = {
      failure: await failureNow(),
      unchanged: await rows(),
    };
    await googleDirectoryHolds(people);
    await googleDirectoryRefuses(403);
    await readAt(nextDay());

    expect({
      failed,
      refused: {
        failure: await failureNow(),
        unchanged: await rows(),
      },
    }).toStrictEqual({
      failed: { failure: "directory.provider_failed", unchanged: before },
      refused: { failure: "directory.not_admin", unchanged: before },
    });
  });

  it("keeps nothing of an erased member, though the directory still lists them", async () => {
    const { admin } = await connectedGoogleDirectory(idp);
    const ann = await memberWith(googleId());
    await googleDirectoryHolds([user({ id: ann.sub }), user()]);
    await readAt(nextDay());
    const tied = await tieOf(ann.sub);
    await admin.api.members.remove(ann.userId);
    await admin.api.members.erase(ann.userId, ann.name);
    const afterErasure = await rowOf(ann.sub);

    await readAt(nextDay());

    expect({
      tied,
      afterErasure,
      afterRead: await rowOf(ann.sub),
      kept: await keptCount(),
    }).toStrictEqual({
      tied: ann.userId,
      afterErasure: undefined,
      afterRead: undefined,
      kept: 1,
    });
  });

  it("suspends a member whose Google account was deleted, and keeps no row for deleted accounts nobody signed in with", async () => {
    await connectedGoogleDirectory(idp);
    const [ann, bea] = [
      await memberWith(googleId()),
      await memberWith(googleId()),
    ];
    await googleDirectoryHolds([user({ id: ann.sub }), user({ id: bea.sub })]);
    await readAt(nextDay());
    // Ann deleted; Bea missing, not deleted; and many deleted strangers.
    await googleDirectoryHolds(
      [],
      [
        { id: ann.sub },
        ...Array.from({ length: 130 }, () => ({ id: googleId() })),
      ]
    );

    await readAt(nextDay());

    expect({
      ann: await suspensionOf(ann.userId),
      bea: await suspensionOf(bea.userId),
      kept: await keptStates(),
    }).toStrictEqual({
      ann: { suspended: 1, suspendedBy: "directory" },
      bea: { suspended: 0, suspendedBy: null },
      kept: [{ id: ann.sub, enabled: 0, deleted: 1 }],
    });
  });

  it("goes on without the deleted users when Google refuses only them, says so, and suspends nobody for having left", async () => {
    await connectedGoogleDirectory(idp);
    const [ann, bea] = [
      await memberWith(googleId()),
      await memberWith(googleId()),
    ];
    await googleDirectoryHolds([user({ id: ann.sub }), user({ id: bea.sub })]);
    await readAt(nextDay());
    // Ann deleted, Bea still listed; the deleted users refused (403).
    await googleDirectoryHolds([user({ id: bea.sub })], [{ id: ann.sub }]);
    await googleDeletedRefuses(403);

    await readAt(nextDay());

    expect({
      read: await env.DB.prepare(
        "SELECT failure, deleted_failure AS deletedFailure, people FROM directory_reads WHERE provider = 'google-directory'"
      ).first(),
      ann: await suspensionOf(ann.userId),
      kept: await keptStates(),
    }).toStrictEqual({
      // Applied as without the deleted list: Bea listed, Ann's row gone.
      read: {
        failure: null,
        deletedFailure: "directory.deleted_refused",
        people: 1,
      },
      ann: { suspended: 0, suspendedBy: null },
      kept: [{ id: bea.sub, enabled: 1, deleted: 0 }],
    });
  });

  it("ties thousands of people to thousands of members in one read, each found by the index on the Google ID", async () => {
    await connectedGoogleDirectory(idp);
    const count = 2000;
    const people = Array.from({ length: count }, () => ({
      id: googleId(),
      userId: crypto.randomUUID(),
    }));
    // Members who signed in with Google, as their sign-ins keep them: too
    // many to sign in one by one in a test.
    const now = Date.now();
    const listed = JSON.stringify(people.map(({ id, userId }) => [id, userId]));
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) SELECT value ->> 1, 'Someone', (value ->> 1) || '@acme.test', 0, ?1, ?1 FROM json_each(?2)"
      ).bind(now, listed),
      env.DB.prepare(
        "INSERT INTO accounts (id, account_id, provider_id, user_id, verified_tenant, created_at, updated_at) SELECT value ->> 1, value ->> 0, 'google', value ->> 1, 'acme.test', ?1, ?1 FROM json_each(?2)"
      ).bind(now, listed),
      env.DB.prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) SELECT value ->> 1, 'organization', value ->> 1, 'user', ?1 FROM json_each(?2)"
      ).bind(now, listed),
    ]);
    await googleDirectoryHolds(people.map(({ id }) => user({ id })));

    await readAt(nextDay());

    const kept = await rows();
    const google = directoryKinds.find(
      ({ provider }) => provider === "google-directory"
    );
    const tie =
      google === undefined
        ? undefined
        : tieDirectoryPeople(drizzle(env.DB), google, sql`1`).toSQL();
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${tie?.sql ?? ""}`)
      .bind(...(tie?.params ?? []))
      .all<{ detail: string }>();
    expect({
      tied: kept.filter(({ userId }) => userId !== null).length,
      byIndex: plan.results.some(({ detail }) =>
        detail.includes(
          "accounts_provider_account_lower_idx (provider_id=? AND <expr>=?)"
        )
      ),
    }).toStrictEqual({ tied: count, byIndex: true });
  });

  it("ties a member whose sign-in lands just before the read's batch", async () => {
    await connectedGoogleDirectory(idp);
    const sub = googleId();
    await googleDirectoryHolds([user({ id: sub }), user()]);
    let userId = "";
    const { coreEnv, landed } = landingAt(
      /insert into "directory_reads"/u,
      "before",
      async () => {
        ({ userId } = await memberWith(sub));
      }
    );

    await readAt(nextDay(), { DB: coreEnv.DB });

    expect({ landed: landed(), tie: await tieOf(sub) }).toStrictEqual({
      landed: true,
      tie: userId,
    });
  });
});
