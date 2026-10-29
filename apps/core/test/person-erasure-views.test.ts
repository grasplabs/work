import type {
  ErasureCursor,
  ErasureRecord,
  RemovedPerson,
} from "@grasp-os/shared/members";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { erasurePageSize } from "../src/person-erasure.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// What admins and Grasp's staff see of erasures (GRA-903, GRA-1195), from
// its threat model first:
// - an admin erasing someone they can't find, or the wrong one of two: the
//   people they removed are listed with where each erasure stands, and
//   nobody still a member;
// - Grasp's staff changing anything, or seeing more than where erasures
//   stand (Nick's D4): their view is read-only, names people by ID and the
//   name frozen when the erasure was asked for, and never an address;
// - a staff view nobody can trace: each is on the audit log as theirs
//   before anything is answered, and none is answered when the log can't
//   take it;
// - anyone else reading either: a builder, an admin reading staff's view.

const idp = mockIdp();

/** An audit log that takes nothing: every call to it fails. */
const failingAuditLog = (): Env["AUDIT_LOG"] =>
  new Proxy(env.AUDIT_LOG, {
    get: (namespace, name): unknown => {
      if (name !== "getByName" && name !== "get") {
        return Reflect.get(namespace, name, namespace);
      }
      return () =>
        new Proxy(
          {},
          {
            get: () => async () =>
              await Promise.reject(new Error("Unavailable")),
          }
        );
    },
  });

/** Grasp staff, signed in to the client's core, over `coreEnv`. */
const staffApi = async (coreEnv: Env = env) => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session, { coreEnv });
  return await core.authenticate();
};

/** An admin with two people they removed, one of them erased since. */
const removedTwo = async () => {
  const admin = await signedInApi(idp, "admin");
  const kept = await signedInApi(idp, "builder");
  const erased = await signedInApi(idp, "user");
  const member = await signedInApi(idp, "user");
  await admin.api.members.remove(kept.userId);
  await admin.api.members.remove(erased.userId);
  await admin.api.members.erase(erased.userId, String(erased.person.name));
  return { admin, kept, erased, member };
};

/**
 * `count` people removed, and erased, long ago: older than anyone the
 * other tests remove, one a second apart, as the database alone writes
 * them. Their IDs, newest first.
 */
const removedLongAgo = async (count: number, by: string): Promise<string[]> => {
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  const base = Date.now() - 365 * 24 * 60 * 60 * 1000;
  await env.DB.batch(
    ids.flatMap((id, index) => {
      const at = base - index * 1000;
      return [
        env.DB.prepare(
          "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)"
        ).bind(id, `Old ${index}`, `erased-${id}@erased.invalid`, at, at),
        env.DB.prepare(
          "INSERT INTO member_removals (organization_id, user_id, removed_at) VALUES ('organization', ?, ?)"
        ).bind(id, at),
        env.DB.prepare(
          "INSERT INTO person_erasures (user_id, name, email_hash, email_key_version, requested_by, requested_at, completed_at) VALUES (?, ?, NULL, 1, ?, ?, ?)"
        ).bind(id, `Old ${index}`, by, at, at),
        env.DB.prepare(
          "INSERT INTO person_erasure_areas (user_id, area, state, attempts, updated_at) VALUES (?, 'identity', 'complete', 0, ?)"
        ).bind(id, at),
      ];
    })
  );
  return ids;
};

/** Every page of a list, from the latest, each from the last one's cursor. */
const allPages = async <T>(
  read: (before?: ErasureCursor) => Promise<{ items: T[]; more: boolean }>,
  cursorOf: (item: T) => ErasureCursor
): Promise<{ items: T[]; pages: number }> => {
  const items: T[] = [];
  let pages = 0;
  let before: ErasureCursor | undefined;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const page = await read(before);
    pages += 1;
    items.push(...page.items);
    const last = page.items.at(-1);
    if (!page.more || last === undefined) {
      return { items, pages };
    }
    before = cursorOf(last);
  }
};

/** Every area of an erasure, done: what a finished one shows. */
const allComplete = [
  "identity",
  "channels",
  "connect",
  "workspace",
  "apps",
  "interview",
  "runs",
  "brain",
].map((area) => ({ area, state: "complete" }));

describe("what admins and Grasp's staff see of erasures", () => {
  it("pages through every removed person and every erasure, however many, each once", async () => {
    const admin = await signedInApi(idp, "admin");
    const staff = await staffApi();
    const old = await removedLongAgo(erasurePageSize + 5, admin.userId);

    const removed = await allPages<RemovedPerson>(
      async (before) => {
        const page = await admin.api.members.removed(before);
        return { items: page.people, more: page.more };
      },
      ({ removedAt, userId }) => ({ at: removedAt, userId })
    );
    const records = await allPages<ErasureRecord>(
      async (before) => {
        const page = await staff.members.erasures(before);
        return { items: page.records, more: page.more };
      },
      ({ requestedAt, userId }) => ({ at: requestedAt, userId })
    );
    const oldIn = (ids: string[]) => ids.filter((id) => old.includes(id));
    const removedIds = removed.items.map(({ userId }) => userId);
    const recordIds = records.items.map(({ userId }) => userId);

    expect({
      removed: oldIn(removedIds),
      removedOnce: new Set(removedIds).size === removedIds.length,
      removedPages: removed.pages > 1,
      records: oldIn(recordIds),
      recordsOnce: new Set(recordIds).size === recordIds.length,
      areas: records.items
        .filter(({ userId }) => old.includes(userId))
        .every(
          ({ areas }) => areas.length === 1 && areas[0]?.state === "complete"
        ),
      bad: await outcome(
        admin.api.members.removed({ at: "yesterday", userId: "x" })
      ),
    }).toStrictEqual({
      removed: old,
      removedOnce: true,
      removedPages: true,
      records: old,
      recordsOnce: true,
      areas: true,
      bad: "member.invalid",
    });
  });

  it("lists the people admins removed for an admin, with where each erasure stands, and nobody still a member", async () => {
    const { admin, kept, erased, member } = await removedTwo();

    const { people: removed } = await admin.api.members.removed();
    const of = (userId: string) =>
      removed.find((person) => person.userId === userId);

    expect({
      kept: of(kept.userId),
      erased: of(erased.userId),
      done: typeof of(erased.userId)?.erasure?.completedAt,
      member: of(member.userId),
    }).toMatchObject({
      kept: {
        name: String(kept.person.name),
        email: String(kept.person.email),
        erasure: null,
        addressKeptOut: false,
      },
      erased: {
        name: String(erased.person.name),
        // Their erasure erased it.
        email: null,
        erasure: {
          areas: allComplete,
        },
        addressKeptOut: true,
      },
      done: "string",
      member: undefined,
    });
  });

  it("shows Grasp staff where each erasure stands, by ID and frozen name only, each view on record as theirs", async () => {
    const { admin, kept, erased } = await removedTwo();
    const staff = await staffApi();

    let records: ErasureRecord[] = [];
    const audited = await auditedDuring(async () => {
      ({ records } = await staff.members.erasures());
    });
    const record = records.find(({ userId }) => userId === erased.userId);

    expect({
      record,
      // Only the erased: someone removed and not erased isn't listed.
      times: [typeof record?.requestedAt, typeof record?.completedAt],
      kept: records.some(({ userId }) => userId === kept.userId),
      // No address of anyone's, theirs or the admin's.
      addresses: JSON.stringify(records).includes("@"),
      audited: audited.map(({ actor, action, detail }) => ({
        actor,
        action,
        detail,
      })),
    }).toMatchObject({
      record: {
        userId: erased.userId,
        name: String(erased.person.name),
        requestedBy: { userId: admin.userId, name: String(admin.person.name) },
        areas: allComplete,
      },
      times: ["string", "string"],
      kept: false,
      addresses: false,
      audited: [
        {
          actor: { type: "staff" },
          action: "member.erasures.viewed",
          detail: {},
        },
      ],
    });
  });

  it("lets Grasp staff change nothing and see no removed person's details, and keeps staff's view theirs", async () => {
    const { erased, kept } = await removedTwo();
    const staff = await staffApi();
    const builder = await signedInApi(idp, "builder");
    const admin = await signedInApi(idp, "admin");

    const audited = await auditedDuring(async () => {
      await expect(
        Promise.all([
          outcome(staff.members.removed()),
          outcome(staff.members.erase(kept.userId, String(kept.person.name))),
          outcome(staff.members.releaseAddress(String(erased.person.email))),
          outcome(builder.api.members.removed()),
          outcome(builder.api.members.erasures()),
          outcome(admin.api.members.erasures()),
        ])
      ).resolves.toStrictEqual([
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
      ]);
    });

    expect(audited).toStrictEqual([]);
  });

  it("answers staff nothing when the audit log can't take their view", async () => {
    await removedTwo();
    const staff = await staffApi({ ...env, AUDIT_LOG: failingAuditLog() });
    // The failed read is logged as an error: that's what it is.
    const logged = vi.spyOn(console, "error").mockReturnValue();

    const answered = await outcome(staff.members.erasures());
    logged.mockRestore();

    expect(answered).not.toBe("ok");
  });
});
