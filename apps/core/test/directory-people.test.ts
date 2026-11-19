import { clockLeaseMs } from "@grasp-os/workerflow/clock";
import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { directoryKinds, tieDirectoryPeople } from "../src/directory-ties.ts";
import { says } from "./agent-chat.ts";
import { landingAt } from "./d1-landing.ts";
import {
  connectedDirectory,
  directoryFailsAt,
  directoryHolds,
  directoryLoopsAt,
  directoryUser as user,
} from "./directory.ts";
import { mockIdp } from "./idp.ts";
import { runClockTask } from "./maintenance.ts";
import { fakeProvider } from "./model-provider.ts";
import { acmeTenant, entraClient, otherTenant } from "./sign-in-config.ts";
import {
  auditedDuring,
  entraPerson,
  signedIn,
  staffPerson,
  whoami,
  withSignIn,
} from "./sign-in.ts";
import { messageFrom, post, teamsPerson, watched } from "./teams-door.ts";

// The directory read once a day (GRA-2056, slice 1): everyone Entra lists,
// by their object ID, tied to the member whose Microsoft sign-in named the
// same object ID in the same tenant. Only Microsoft Graph is faked; core,
// connect and sign-in are the real ones. The ways it could go wrong come
// first: someone tied by anything but a verified object ID and tenant, a
// failed or older read changing what a good one left, an erased person
// coming back.

const idp = mockIdp();
watched();
const dayMs = 24 * 60 * 60 * 1000;
const task = "directory.people";

let days = 0;
/** A time past every read so far by more than a day: a read is due then. */
const nextDay = (): Date => {
  days += 2;
  return new Date(Date.now() + days * dayMs);
};

/** The clock's daily read, run for the slot at `at`. */
const readAt = async (at: Date, changes: Partial<Env> = {}): Promise<void> => {
  await runClockTask(task, changes, at);
};

/** Someone who signed in with Microsoft under `oid`, in `tenant`, as a member. */
const memberWith = async (oid: string, tenant = acmeTenant) => {
  const person = entraPerson(tenant, "acme.test", { oid });
  const session = await signedIn(idp, "microsoft", person, {
    coreEnv: withSignIn({
      admins: [String(person.email)],
      entra: { tenantId: tenant, clientId: entraClient.id },
    }),
  });
  const { userId } = await whoami(session);
  return { oid, userId, name: String(person.name) };
};

interface Row {
  tenant: string;
  id: string;
  department: string;
  enabled: number;
  userId: string | null;
}

/** What the read keeps now, by object ID. */
const rows = async (): Promise<Row[]> => {
  const { results } = await env.DB.prepare(
    "SELECT tenant, account_id AS id, department, enabled, user_id AS userId FROM directory_people ORDER BY account_id"
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

/** A row as a read with nobody tied keeps it. */
const untiedRow = (
  id: string | undefined,
  department: string,
  enabled = 1
): Row => ({
  tenant: acmeTenant,
  id: String(id),
  department,
  enabled,
  userId: null,
});

/** `list` in the order `rows` answers. */
const byId = (list: Row[]): Row[] =>
  list.toSorted((one, other) => one.id.localeCompare(other.id));

/** Where the read stands, for the admin. */
const status = async () =>
  await env.DB.prepare(
    "SELECT failure, failed_at IS NOT NULL AS failed, people, disabled FROM directory_reads WHERE provider = 'microsoft-directory'"
  ).first<{
    failure: string | null;
    failed: number;
    people: number | null;
    disabled: number | null;
  }>();

describe("the directory's daily read", () => {
  it("keeps everyone a read of several pages lists by their object ID, ties the member who signed in before it, and records the read once, with counts alone", async () => {
    await connectedDirectory(idp);
    const ann = await memberWith(crypto.randomUUID());
    const people = Array.from({ length: 230 }, (_, index) =>
      user({
        displayName: `Person ${String(index)}`,
        department: index % 2 === 0 ? "Finance" : "Sales",
      })
    );
    people[170] = user({
      id: ann.oid,
      displayName: "Ann de Vries",
      mail: "ann@acme.test",
      department: "Finance",
    });
    const left = user({ displayName: "Left", accountEnabled: false });
    await directoryHolds([
      ...people,
      left,
      user({ displayName: "A guest", userType: "Guest" }),
    ]);

    const events = await auditedDuring(async () => {
      await readAt(nextDay());
    });

    const kept = await rows();
    const recorded = events.filter(
      ({ action }) => action === "directory.people_read"
    );
    expect({
      kept: kept.length,
      tenants: [...new Set(kept.map(({ tenant }) => tenant))],
      ann: await rowOf(ann.oid),
      left: await rowOf(String(left.id)),
      tied: kept.filter(({ userId }) => userId !== null).length,
      recorded: recorded.map(({ actor, target, detail }) => ({
        actor,
        target: target?.type,
        detail,
      })),
      // Counts and the connection alone: nobody's ID, name or address.
      named: JSON.stringify(recorded).includes(ann.oid),
      status: await status(),
    }).toStrictEqual({
      kept: 231,
      tenants: [acmeTenant],
      ann: {
        tenant: acmeTenant,
        id: ann.oid,
        department: "Finance",
        enabled: 1,
        userId: ann.userId,
      },
      left: {
        tenant: acmeTenant,
        id: String(left.id),
        department: "",
        enabled: 0,
        userId: null,
      },
      tied: 1,
      recorded: [
        {
          actor: { type: "system" },
          target: "connection",
          detail: {
            provider: "microsoft-directory",
            people: 230,
            disabled: 1,
            tied: 1,
          },
        },
      ],
      named: false,
      status: { failure: null, failed: 0, people: 230, disabled: 1 },
    });
  });

  it("takes a joiner, a renamed department, a disabled account and a leaver from the next day's read, and reads no more than once a day", async () => {
    await connectedDirectory(idp);
    const [stays, renamed, disabled, leaves, joins] = Array.from(
      { length: 5 },
      () => crypto.randomUUID()
    );
    await directoryHolds([
      user({ id: stays, department: "Finance" }),
      user({ id: renamed, department: "Sales" }),
      user({ id: disabled, department: "Support" }),
      user({ id: leaves, department: "Support" }),
    ]);
    await readAt(nextDay());
    const first = await rows();
    await directoryHolds([
      user({ id: stays, department: "Finance" }),
      user({ id: renamed, department: "Inside sales" }),
      user({ id: disabled, department: "Support", accountEnabled: false }),
      user({ id: joins, department: "Finance" }),
    ]);

    // The read that ran just now was applied less than a day ago.
    await readAt(new Date());
    const sameDay = await rows();
    await readAt(nextDay());

    expect({ sameDay, next: await rows() }).toStrictEqual({
      sameDay: first,
      next: byId([
        untiedRow(stays, "Finance"),
        untiedRow(renamed, "Inside sales"),
        untiedRow(disabled, "", 0),
        untiedRow(joins, "Finance"),
      ]),
    });
  });

  it("changes nothing when a page fails, records why, and applies the whole directory at the next quarter hour", async () => {
    await connectedDirectory(idp);
    const before = Array.from({ length: 150 }, () => user());
    await directoryHolds(before);
    await readAt(nextDay());
    const good = await rows();
    const joiners = Array.from({ length: 10 }, () => user());
    await directoryHolds([...before, ...joiners]);
    await directoryFailsAt(100);

    const at = nextDay();
    const events = await auditedDuring(async () => {
      await readAt(at);
    });
    const failed = { rows: await rows(), status: await status() };
    await directoryHolds([...before, ...joiners]);
    await readAt(new Date(at.getTime() + 15 * 60 * 1000));
    const after = await rows();

    expect({
      failed,
      recorded: events.filter(
        ({ action }) => action === "directory.people_read"
      ).length,
      after: { kept: after.length, status: await status() },
    }).toStrictEqual({
      failed: {
        rows: good,
        status: {
          failure: "directory.provider_failed",
          failed: 1,
          people: 150,
          disabled: 0,
        },
      },
      recorded: 0,
      after: {
        kept: 160,
        status: { failure: null, failed: 0, people: 160, disabled: 0 },
      },
    });
  });

  it("refuses as too large a directory whose escaped JSON is over D1's value, though its text alone fits, and applies none of it", async () => {
    await connectedDirectory(idp);
    await directoryHolds([user()]);
    await readAt(nextDay());
    const good = await rows();
    // Quotes and backslashes, each escaped in JSON: 80 characters of text,
    // 160 of JSON. 9,000 such people are 1.7 MB of text and 2.5 MB of JSON.
    const department = '"\\'.repeat(40);
    await directoryHolds(
      Array.from({ length: 9000 }, () => user({ department }))
    );

    await readAt(nextDay());
    const now = await status();

    expect({ rows: await rows(), failure: now?.failure }).toStrictEqual({
      rows: good,
      failure: "directory.too_large",
    });
  });

  it("records a batch D1 refuses as the read's failure, and changes nothing", async () => {
    await connectedDirectory(idp);
    await directoryHolds([user()]);
    await readAt(nextDay());
    const good = await rows();
    await directoryHolds([user(), user()]);
    // D1 refusing the read's batch, as it would one past its limits.
    const refusing = new Proxy(env.DB, {
      get: (target, key) => {
        if (key === "batch") {
          return async (): Promise<never> =>
            await Promise.reject(new Error("D1_ERROR: refused"));
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });

    const outcome = await readAt(nextDay(), { DB: refusing }).then(
      () => "applied",
      (error: unknown) => (error instanceof Error ? error.message : "refused")
    );
    const now = await status();

    expect({
      outcome,
      rows: await rows(),
      failure: now?.failure,
    }).toStrictEqual({
      outcome: "D1_ERROR: refused",
      rows: good,
      failure: "directory.read_failed",
    });
  });

  it("fails the whole read when the directory repeats a next link, and applies none of it", async () => {
    await connectedDirectory(idp);
    await directoryHolds([user()]);
    await readAt(nextDay());
    const good = await rows();
    await directoryHolds(Array.from({ length: 250 }, () => user()));
    await directoryLoopsAt(100);

    await readAt(nextDay());
    const now = await status();

    expect({ rows: await rows(), failure: now?.failure }).toStrictEqual({
      rows: good,
      failure: "directory.provider_failed",
    });
  });

  it("fails the whole read once the clock's lease on it is over, applies none of it, and says so", async () => {
    await connectedDirectory(idp);
    await directoryHolds([user()]);
    await readAt(nextDay());
    const good = await rows();
    await directoryHolds([user(), user()]);
    // A read started more than a lease ago, the last one applied two days
    // before that: due, but already past the time the clock gave it.
    const at = new Date(Date.now() - clockLeaseMs - 60_000);
    await env.DB.prepare(
      "UPDATE directory_reads SET read_at = ? WHERE provider = 'microsoft-directory'"
    )
      .bind(at.getTime() - 2 * dayMs)
      .run();

    await readAt(at);
    const now = await status();

    expect({ rows: await rows(), failure: now?.failure }).toStrictEqual({
      rows: good,
      failure: "directory.read_too_long",
    });
  });

  it("ties a member who signs in after the read at their sign-in, by the read's own rule", async () => {
    await connectedDirectory(idp);
    const oid = crypto.randomUUID();
    await directoryHolds([user({ id: oid, department: "Legal" })]);
    await readAt(nextDay());
    const untied = await tieOf(oid);

    const ben = await memberWith(oid);

    expect({ untied, tied: await tieOf(oid) }).toStrictEqual({
      untied: null,
      tied: ben.userId,
    });
  });

  it("never ties someone whose sign-in named the same object ID in another tenant, or a Grasp staff member", async () => {
    await connectedDirectory(idp);
    const oid = crypto.randomUUID();
    const elsewhere = await memberWith(oid, otherTenant);
    const { userId: staffId } = await whoami(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    await directoryHolds([
      user({ id: oid }),
      user({ id: String(staffPerson().oid) }),
    ]);

    await readAt(nextDay());
    // And again as they sign in, by the same rule.
    await memberWith(oid, otherTenant);

    const kept = await rows();
    expect({
      ties: kept.map(({ userId }) => userId),
      nobody: [elsewhere.userId, staffId].some((id) =>
        kept.some(({ userId }) => userId === id)
      ),
    }).toStrictEqual({ ties: [null, null], nobody: false });
  });

  it("unties a member an admin removed, and after their erasure keeps nothing of them, though the directory still lists them", async () => {
    const { admin } = await connectedDirectory(idp);
    const cas = await memberWith(crypto.randomUUID());
    const other = user({ department: "Sales" });
    await directoryHolds([user({ id: cas.oid, department: "Finance" }), other]);
    await readAt(nextDay());
    const tied = await tieOf(cas.oid);

    await admin.api.members.remove(cas.userId);
    await readAt(nextDay());
    const removed = await rowOf(cas.oid);
    await admin.api.members.erase(cas.userId, cas.name);
    const erased = await rows();
    await readAt(nextDay());

    // Every column of every row, after a read that still lists them.
    const { results: walk } = await env.DB.prepare(
      "SELECT * FROM directory_people"
    ).all();
    const theirs = (value: unknown) =>
      typeof value === "string" &&
      (value.toLowerCase() === cas.oid || value === cas.userId);
    expect({
      tied,
      removed: removed?.userId,
      erased: erased.map(({ id }) => id),
      found: walk.flatMap((row) => Object.values(row).filter(theirs)),
      others: walk.map(({ account_id: id }) => id),
    }).toStrictEqual({
      tied: cas.userId,
      removed: null,
      erased: [String(other.id)],
      found: [],
      others: [String(other.id)],
    });
  });

  it("keeps a newer read when an older one, started first, tries to apply after it", async () => {
    await connectedDirectory(idp);
    const [older, newer] = [crypto.randomUUID(), crypto.randomUUID()];
    await directoryHolds([user({ id: older })]);
    const at = nextDay();
    // The older read has read every page; before its batch lands, a read
    // started after it reads the directory as it is now and applies it.
    const { coreEnv, landed } = landingAt(
      /insert into "directory_reads"/u,
      "before",
      async () => {
        await directoryHolds([user({ id: newer })]);
        await readAt(at);
      }
    );

    await readAt(at, { DB: coreEnv.DB });
    const kept = await rows();

    expect({
      landed: landed(),
      kept: kept.map(({ id }) => id),
    }).toStrictEqual({ landed: true, kept: [newer] });
  });

  it("keeps a newer read's standing when an older one, started first, fails after it was applied", async () => {
    await connectedDirectory(idp);
    const newer = crypto.randomUUID();
    await directoryHolds([user()]);
    await directoryFailsAt(0);
    const at = nextDay();
    const { coreEnv, landed } = landingAt(
      /insert into "directory_reads"/u,
      "before",
      async () => {
        await directoryHolds([user({ id: newer })]);
        await readAt(at);
      }
    );

    await readAt(at, { DB: coreEnv.DB });
    const kept = await rows();

    expect({
      landed: landed(),
      kept: kept.map(({ id }) => id),
      status: await status(),
    }).toStrictEqual({
      landed: true,
      kept: [newer],
      status: { failure: null, failed: 0, people: 1, disabled: 0 },
    });
  });

  it("after the erasure of a member a Teams message made, who never signed in, keeps nothing of them, though the directory still lists them", async () => {
    const oid = crypto.randomUUID();
    await directoryHolds([
      user({ id: oid, displayName: "Sanne de Vries", department: "Finance" }),
    ]);
    const { admin } = await connectedDirectory(idp);
    await fakeProvider(says("Answered."));
    await post(messageFrom(teamsPerson(oid)));
    const made = await env.DB.prepare(
      "SELECT user_id AS userId, provider_id AS provider FROM accounts WHERE oid = ?"
    )
      .bind(oid)
      .all<{ userId: string; provider: string }>();
    const [account] = made.results;
    const userId = account?.userId ?? "";
    await readAt(nextDay());
    const listed = await rowOf(oid);

    await admin.api.members.remove(userId);
    await admin.api.members.erase(userId, "Sanne de Vries");
    const erased = await rowOf(oid);
    await readAt(nextDay());

    expect({
      accounts: made.results.map(({ provider }) => provider),
      // Never tied: a tie is for a Microsoft sign-in alone.
      listed: listed?.userId,
      erased,
      after: await rowOf(oid),
    }).toStrictEqual({
      accounts: ["entra-directory"],
      listed: null,
      erased: undefined,
      after: undefined,
    });
  });

  it("keeps an account with no name listed, as any account that is on", async () => {
    await connectedDirectory(idp);
    const nameless = crypto.randomUUID();
    await directoryHolds([
      user({ id: nameless, displayName: "", department: "Finance" }),
    ]);

    await readAt(nextDay());

    await expect(rowOf(nameless)).resolves.toStrictEqual(
      untiedRow(nameless, "Finance")
    );
  });

  it("refuses a read whose pages say another tenant than the one the deployment signs in from, and changes nothing", async () => {
    await connectedDirectory(idp);
    await directoryHolds([user()]);
    await readAt(nextDay());
    const good = await rows();
    await directoryHolds([user(), user()]);
    // Connect answering for another tenant than its connection said.
    const real = env.CONNECT;
    const elsewhere = new Proxy(real, {
      get: (target, key) => {
        if (key === "readDirectory") {
          return async (request: Parameters<typeof real.readDirectory>[0]) => ({
            ...(await target.readDirectory(request)),
            tenant: otherTenant,
          });
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });

    await readAt(nextDay(), { CONNECT: elsewhere });
    const now = await status();

    expect({ rows: await rows(), failure: now?.failure }).toStrictEqual({
      rows: good,
      failure: "directory.other_tenant",
    });
  });

  it("ties thousands of people to thousands of members in one read, each found by the object ID index", async () => {
    await connectedDirectory(idp);
    const count = 3000;
    const people = Array.from({ length: count }, () => ({
      oid: crypto.randomUUID(),
      userId: crypto.randomUUID(),
    }));
    // Members who signed in with Microsoft, as their sign-ins keep them:
    // too many to sign in one by one in a test.
    const now = Date.now();
    const listed = JSON.stringify(
      people.map(({ oid, userId }) => [oid, userId])
    );
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) SELECT value ->> 1, 'Someone', (value ->> 1) || '@acme.test', 0, ?1, ?1 FROM json_each(?2)"
      ).bind(now, listed),
      env.DB.prepare(
        "INSERT INTO accounts (id, account_id, provider_id, user_id, oid, verified_tenant, created_at, updated_at) SELECT value ->> 1, 'sub-' || (value ->> 1), 'microsoft', value ->> 1, value ->> 0, ?1, ?2, ?2 FROM json_each(?3)"
      ).bind(acmeTenant, now, listed),
      env.DB.prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) SELECT value ->> 1, 'organization', value ->> 1, 'user', ?1 FROM json_each(?2)"
      ).bind(now, listed),
    ]);
    await directoryHolds(people.map(({ oid }) => user({ id: oid })));

    await readAt(nextDay());

    const kept = await rows();
    const [entra] = directoryKinds;
    const tie =
      entra === undefined
        ? undefined
        : tieDirectoryPeople(drizzle(env.DB), entra, sql`1`).toSQL();
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${tie?.sql ?? ""}`)
      .bind(...(tie?.params ?? []))
      .all<{ detail: string }>();
    expect({
      tied: kept.filter(({ userId }) => userId !== null).length,
      byIndex: plan.results.some(({ detail }) =>
        detail.includes("accounts_oid_idx")
      ),
    }).toStrictEqual({ tied: count, byIndex: true });
  });
});
