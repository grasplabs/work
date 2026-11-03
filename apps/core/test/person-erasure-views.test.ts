import type { ErasureCursor, RemovedPerson } from "@grasp-os/shared/members";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

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

// What admins see of erasures (GRA-903, GRA-1195), from its threat model
// first:
// - an admin erasing someone they can't find, or the wrong one of two: the
//   people they removed are listed with where each erasure stands, and
//   nobody still a member;
// - anyone else reading the list or erasing: a builder, or Grasp's staff,
//   who never reach a client's workspace (#1782).

const idp = mockIdp();

/** Grasp staff, signed in to the client's core. */
const staffApi = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session, { coreEnv: env });
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

describe("what admins see of erasures", () => {
  it("pages through every removed person, however many, each once", async () => {
    const admin = await signedInApi(idp, "admin");
    const old = await removedLongAgo(erasurePageSize + 5, admin.userId);

    const removed = await allPages<RemovedPerson>(
      async (before) => {
        const page = await admin.api.members.removed(before);
        return { items: page.people, more: page.more };
      },
      ({ removedAt, userId }) => ({ at: removedAt, userId })
    );
    const oldIn = (ids: string[]) => ids.filter((id) => old.includes(id));
    const removedIds = removed.items.map(({ userId }) => userId);

    expect({
      removed: oldIn(removedIds),
      removedOnce: new Set(removedIds).size === removedIds.length,
      removedPages: removed.pages > 1,
      areas: removed.items
        .filter(({ userId }) => old.includes(userId))
        .every(
          ({ erasure }) =>
            erasure?.areas.length === 1 &&
            erasure.areas[0]?.state === "complete"
        ),
      bad: await outcome(
        admin.api.members.removed({ at: "yesterday", userId: "x" })
      ),
    }).toStrictEqual({
      removed: old,
      removedOnce: true,
      removedPages: true,
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

  it("lets neither Grasp staff nor a builder see removed people or change anything", async () => {
    const { erased, kept } = await removedTwo();
    const staff = await staffApi();
    const builder = await signedInApi(idp, "builder");

    const audited = await auditedDuring(async () => {
      await expect(
        Promise.all([
          outcome(staff.members.removed()),
          outcome(staff.members.erase(kept.userId, String(kept.person.name))),
          outcome(staff.members.releaseAddress(String(erased.person.email))),
          outcome(builder.api.members.removed()),
        ])
      ).resolves.toStrictEqual([
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
      ]);
    });

    expect(audited).toStrictEqual([]);
  });
});
