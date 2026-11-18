import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import type { Roster } from "@grasp-os/shared/onboarding";
import { teamNameKey } from "@grasp-os/shared/onboarding";
import type { SQL } from "drizzle-orm";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { revocationsOf, tellKept } from "./access-revocations.ts";
import { appsOwnedOrSharedNow } from "./app-access.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { activeMember, organizationId } from "./auth/membership-sql.ts";
import {
  staffListPlaced,
  retiredTeamIds,
  teamMembers,
  teamPrimaries,
  teams,
  users,
} from "./db/core/schema.ts";
import { chunks, inList } from "./db/d1.ts";
import { onboardingStore } from "./onboarding/store.ts";
import type { ConfirmedPlaces } from "./onboarding/store.ts";

// One list of teams with one id (GRA-2055): the onboarding's staff list
// names the members' teams (Better Auth's `teams`), never teams of its
// own. Its people stay its own (most have no account), and so do a team's
// lead, its description and whether it takes part, kept by the onboarding
// store beside the team under the team's id. The ways this can leak, and
// what stops each:
//
// - Someone placed in a team reads what the team's members read. Only an
//   admin's confirm places anyone (`placePrimaries`), never a draft save;
//   only a current member (not removed, checked in the statement itself),
//   found by the address their company's sign-in verified, never by name
//   nor by a directory placeholder; every placement and removal audited.
// - Nothing automatic overrides what an admin did by hand (`placementOf`):
//   the list adds a membership only when the team it gives someone
//   changes, and takes away only one it made itself.
// - A deleted team's id coming back with what was shared with it: a team's
//   id is a members' team's, or one core made for the list
//   (`crypto.randomUUID`, marked `minted` in the store), never one a
//   request sent; a confirm makes a members' team only under a minted id,
//   so an id whose team was deleted while a save ran is never made again.
// - A rename or a confirm splitting what one team holds: a team keeps one
//   id from the first save that names it, and everything keys by it.
// - A team the admin only drafted: made at the confirm, never before, so a
//   draft fixed before it leaves no team behind.

/** The open-page notices a leave keeps (`revocationsOf`), as its rows read back. */
const keptRowsSchema = z.array(
  z.object({
    id: z.string(),
    appId: z.string().nullable(),
    userIds: z.array(z.string()).nullable(),
    attempts: z.number(),
    createdAt: z.date(),
    afterAppId: z.string().nullable(),
  })
);

/** The memberships a leave's delete returns (`placementOf`). */
const leftRowsSchema = z.array(
  z.object({ teamId: z.string(), userId: z.string() })
);

/** The directory's placeholder addresses (auth/directory-members.ts): no sign-in verified them. */
const placeholderSuffix = "%@directory.invalid";

/** How many people's changes go in one batch: six statements each at most. */
const peoplePerBatch = 50;

/** What a staff-list change records as how it was made. */
const via = "staffList";

/** A team of the staff list the onboarding's store holds now. */
export interface HeldTeam {
  id: string;
  name: string;
  /** Whether core made its id for the list (`teams.minted`). */
  minted: boolean;
}

/**
 * `roster` with each of its teams under the one id it keeps for good
 * (GRA-2055): a members' team's, or one core made for the list (`minted`)
 * that the onboarding's store holds (`held`), by its id, else by its name
 * (trimmed, any case) where one alone has it and no other team on the list
 * took it; else a new id core makes, never the one the request sent. A held
 * id that is neither (a members' team deleted while a save ran) is never
 * kept: no deleted team's id comes back, with what was shared with it. The
 * id never changes after: a team new on a draft is kept under it in the
 * store, and with `make` (the admin confirmed the list) its members' team
 * is made under that same id, and the members' teams are renamed to the
 * names the list gives. A draft writes nothing here, so a draft put right
 * before the confirm leaves no team in Settings › Members. None is ever
 * deleted here, as one may hold what was shared with it. Answers the
 * roster as the store keeps it, and the ids core made for it (`minted`).
 */
export const intoMembersTeams = async (
  env: Env,
  roster: Roster,
  actor: AuditActor,
  {
    make,
    held: heldNow,
  }: {
    make: boolean;
    /** The store's teams, read only after the members' teams are. */
    held: () => Promise<readonly HeldTeam[]>;
  }
): Promise<{ roster: Roster; minted: Set<string> }> => {
  const db = drizzle(env.DB);
  // The members' teams first, then the store's: a team deleted in between
  // is missing from the first read and so never kept by the second. No
  // test can pin this order; the insert's own guard below is what holds.
  const [existing, madeBefore] = await db.batch([
    db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(eq(teams.organizationId, organizationId)),
    db.select({ id: retiredTeamIds.id }).from(retiredTeamIds),
  ]);
  const held = await heldNow();
  const known = new Map(existing.map(({ id, name }) => [id, name]));
  // A minted id that is retired (the list made a team of it, or a team of
  // it was deleted) and is no members' team now was deleted: it is never
  // kept, and its team gets a new id. What the store holds under the old id is left on purpose: the
  // admin deleted that team, and nothing of it may reach the new one.
  const madeEver = new Set(madeBefore.map(({ id }) => id));
  const mintedHeld = held.filter(
    ({ id, minted }) => minted && !known.has(id) && !madeEver.has(id)
  );
  const kept = new Set([...known.keys(), ...mintedHeld.map(({ id }) => id)]);
  const byName = new Map<string, Set<string>>();
  for (const { id, name } of [...existing, ...mintedHeld]) {
    const key = teamNameKey(name);
    byName.set(key, (byName.get(key) ?? new Set()).add(id));
  }
  // Ids first, then names, so a team the list holds by its id is never
  // taken by another of the list's teams through its name.
  const taken = new Set(
    roster.teams.flatMap(({ id }) => (kept.has(id) ? [id] : []))
  );
  const idOf = new Map<string, string>();
  const mintedNow = new Set<string>();
  for (const team of roster.teams) {
    if (kept.has(team.id)) {
      idOf.set(team.id, team.id);
      continue;
    }
    const [named, ...others] = [
      ...(byName.get(teamNameKey(team.name)) ?? []),
    ].filter((id) => !taken.has(id));
    const id =
      named !== undefined && others.length === 0 ? named : crypto.randomUUID();
    if (id !== named) {
      mintedNow.add(id);
    }
    taken.add(id);
    idOf.set(team.id, id);
  }
  const listed = roster.teams.map((team) => ({
    ...team,
    id: idOf.get(team.id) ?? team.id,
  }));
  const made = listed.filter(({ id }) => !known.has(id));
  const renamed = listed.filter(({ id, name }) => {
    const was = known.get(id);
    return was !== undefined && was !== name;
  });
  if (make && (made.length > 0 || renamed.length > 0)) {
    const now = new Date();
    const entry = (action: string, id: string): AuditEntry => ({
      actor,
      action,
      target: { type: "team", id },
      detail: { via },
    });
    const [first, ...rest] = [
      ...made.flatMap(({ id, name }) => [
        // As Better Auth's own create-team makes a team, under the id kept,
        // and only under one never retired: the proof is in this statement,
        // so no read, however old, makes a deleted team's id again.
        db
          .insert(teams)
          .select(
            sql`SELECT ${id}, ${name}, 0, ${organizationId}, ${now.getTime()}, ${now.getTime()}
              WHERE NOT EXISTS (SELECT 1 FROM ${retiredTeamIds} WHERE ${retiredTeamIds.id} = ${id})`
          )
          .onConflictDoNothing(),
        outboxedIfChanged(db, entry("team.created", id)),
        db.insert(retiredTeamIds).values({ id }).onConflictDoNothing(),
      ]),
      ...renamed.flatMap(({ id, name }) => [
        db
          .update(teams)
          .set({ name, updatedAt: now })
          .where(
            and(eq(teams.id, id), eq(teams.organizationId, organizationId))
          ),
        outboxedIfChanged(db, entry("team.updated", id)),
      ]),
    ];
    if (first !== undefined) {
      await auditedBatch(env, db, [first, ...rest]);
    }
  }
  const wasMinted = new Set(mintedHeld.map(({ id }) => id));
  return {
    roster: {
      teams: listed,
      people: roster.people.map((person) => ({
        ...person,
        team: idOf.get(person.team) ?? person.team,
      })),
    },
    minted: new Set(
      listed.flatMap(({ id }) =>
        mintedNow.has(id) || wasMinted.has(id) ? [id] : []
      )
    ),
  };
};

/**
 * The key Better Auth gives a team membership, which its unique index on
 * `team_members.membership_key` keeps to one row per person and team:
 * SHA-256 of `[teamId, userId]` as JSON, base64url without padding, as its
 * organization plugin's `computeTeamMembershipKey` makes it (adapter.ts,
 * which it doesn't export).
 */
const membershipKeyOf = async (
  teamId: string,
  userId: string
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([teamId, userId]))
  );
  return btoa(String.fromCodePoint(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

/** The team the list last gave someone, and whether the list made that membership itself. */
export interface Placed {
  teamId: string;
  made: boolean;
}

/** One change the list makes to someone's teams, as `placementOf` decides it. */
interface Placement {
  userId: string;
  before: Placed | undefined;
  /** The team the list gives them now; none when it gives them none. */
  after: string | undefined;
  /** The key of the membership in `after` (`membershipKeyOf`). */
  key: string | undefined;
}

/**
 * The staff list's rule for one person (GRA-2055), decided here alone:
 * nothing automatic overrides what an admin did by hand. The list touches
 * someone's memberships only when the team it gives them changes, from
 * `before` to `after`: then it takes away the old one only if it made it
 * itself (`made`), never one an admin added by hand, and adds the new one,
 * recording whether it made it (an admin may have added it already). It
 * never adds a membership in the team their primary row already names: an
 * admin who took that one away by hand keeps it away. Confirms never
 * interleave (`placePrimaries`), so what they read stands; what an admin
 * does by hand meanwhile is checked in the statements themselves. Every
 * statement holds only while `holds` (this confirm's version is the one
 * placed). The statements of one person go in one batch, a move's leave
 * and join together; a leave's open-page notice is kept in the batch with
 * it (`revocationsOf`). None when the read saw no change.
 */
export const placementOf = (
  db: DrizzleD1Database,
  actor: AuditActor,
  { userId, before, after, key }: Placement,
  now: Date,
  holds: SQL
) => {
  if (before?.teamId === after) {
    return { statements: [], leaves: false };
  }
  const entry = (
    action: "team.member.added" | "team.member.removed",
    teamId: string
  ): AuditEntry => ({
    actor,
    action,
    target: { type: "team", id: teamId },
    detail: { userId, via },
  });
  const isPrimary = (teamId: string) =>
    sql`EXISTS (SELECT 1 FROM ${teamPrimaries} WHERE ${teamPrimaries.userId} = ${userId} AND ${teamPrimaries.teamId} = ${teamId})`;
  const leave =
    before === undefined
      ? []
      : (() => {
          const listMade = sql`EXISTS (SELECT 1 FROM ${teamPrimaries} WHERE ${teamPrimaries.userId} = ${userId} AND ${teamPrimaries.teamId} = ${before.teamId} AND ${teamPrimaries.made} = 1)`;
          const isInBefore = sql`EXISTS (SELECT 1 FROM ${teamMembers} WHERE ${teamMembers.userId} = ${userId} AND ${teamMembers.teamId} = ${before.teamId})`;
          return [
            // First, while the membership is still there to say what it
            // reached: a notice for each App they reach now, which the
            // clock tells if the pages aren't told after this commits.
            revocationsOf(
              db,
              appsOwnedOrSharedNow(userId),
              [userId],
              sql`${holds} AND ${listMade} AND ${isInBefore}`
            ),
            db
              .delete(teamMembers)
              .where(
                and(
                  eq(teamMembers.userId, userId),
                  eq(teamMembers.teamId, before.teamId),
                  listMade,
                  holds
                )
              )
              .returning({
                teamId: teamMembers.teamId,
                userId: teamMembers.userId,
              }),
            outboxedIfChanged(db, entry("team.member.removed", before.teamId)),
            ...(after === undefined
              ? [
                  db
                    .delete(teamPrimaries)
                    .where(and(eq(teamPrimaries.userId, userId), holds)),
                ]
              : []),
          ];
        })();
  if (after === undefined || key === undefined) {
    return { statements: leave, leaves: leave.length > 0 };
  }
  const memberId = crypto.randomUUID();
  const isIn = sql`EXISTS (SELECT 1 FROM ${teamMembers} WHERE ${teamMembers.userId} = ${userId} AND ${teamMembers.teamId} = ${after})`;
  return {
    leaves: leave.length > 0,
    statements: [
      ...leave,
      // In one statement with the checks: someone removed, or a team
      // deleted, since the read gets nothing; nor does a membership an
      // admin added meanwhile, by its pair or Better Auth's key; nor one in
      // the team their primary row already names.
      db
        .insert(teamMembers)
        .select(
          sql`SELECT ${memberId}, ${after}, ${userId}, ${key}, ${now.getTime()}
            WHERE ${holds}
              AND ${activeMember(userId)}
              AND EXISTS (SELECT 1 FROM ${teams} WHERE ${teams.id} = ${after} AND ${teams.organizationId} = ${organizationId})
              AND NOT ${isIn}
              AND NOT ${isPrimary(after)}`
        )
        .onConflictDoNothing(),
      outboxedIfChanged(db, entry("team.member.added", after)),
      // Made by the list only if its own insert made the row.
      db
        .insert(teamPrimaries)
        .select(
          sql`SELECT ${userId}, ${after}, ${now.getTime()},
              EXISTS (SELECT 1 FROM ${teamMembers} WHERE ${teamMembers.id} = ${memberId})
            WHERE ${holds} AND ${isIn} AND NOT ${isPrimary(after)}`
        )
        .onConflictDoUpdate({
          target: teamPrimaries.userId,
          set: {
            teamId: sql`excluded.team_id`,
            placedAt: sql`excluded.placed_at`,
            made: sql`excluded.made`,
          },
        }),
    ],
  };
};

/**
 * `placePrimaries` for one claimed version: each current member whose
 * verified address its list names goes in that team, as their primary
 * one; whoever it moved, took off, or no longer finds leaves the team it
 * gave them before, by the one rule (`placementOf`). Each change audited.
 */
const placeVersion = async (
  env: Env,
  actor: AuditActor,
  { version, places }: ConfirmedPlaces
): Promise<void> => {
  const db = drizzle(env.DB);
  const holds = sql`EXISTS (SELECT 1 FROM ${staffListPlaced} WHERE ${staffListPlaced.organizationId} = ${organizationId} AND ${staffListPlaced.version} = ${version})`;
  const teamOf = new Map(places.map(({ email, team }) => [email, team]));
  const [found, placed] = await db.batch([
    db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(
        and(
          inList(sql`lower(${users.email})`, [...teamOf.keys()]),
          sql`${users.email} NOT LIKE ${placeholderSuffix}`,
          activeMember(users.id)
        )
      ),
    db
      .select({
        userId: teamPrimaries.userId,
        teamId: teamPrimaries.teamId,
        made: teamPrimaries.made,
      })
      .from(teamPrimaries),
  ]);
  const wanted = new Map<string, string>();
  for (const { id, email } of found) {
    const team = teamOf.get(email.toLowerCase());
    if (team !== undefined) {
      wanted.set(id, team);
    }
  }
  const was = new Map(
    placed.map(({ userId, teamId, made }) => [userId, { teamId, made }])
  );
  const changes = await Promise.all(
    [...new Set([...was.keys(), ...wanted.keys()])]
      .filter((userId) => was.get(userId)?.teamId !== wanted.get(userId))
      .map(async (userId): Promise<Placement> => {
        const after = wanted.get(userId);
        return {
          userId,
          before: was.get(userId),
          after,
          key:
            after === undefined
              ? undefined
              : await membershipKeyOf(after, userId),
        };
      })
  );
  const now = new Date();
  // What the batches actually left, by the leaves' own returned rows.
  const left: { teamId: string; userId: string }[] = [];
  // Each person's change whole in one batch: a move never ends half done.
  for (const part of chunks(changes, peoplePerBatch)) {
    const groups = part.map((change) =>
      placementOf(db, actor, change, now, holds)
    );
    // Where each leaving person's statements start: its notice, then its
    // removal.
    const leaves: number[] = [];
    let at = 0;
    for (const { statements, leaves: leaving } of groups) {
      if (leaving) {
        leaves.push(at);
      }
      at += statements.length;
    }
    const [first, ...rest] = groups.flatMap(({ statements }) => statements);
    if (first !== undefined) {
      // Batches one after another, each within D1's limits.
      // oxlint-disable-next-line no-await-in-loop
      const results = await auditedBatch(env, db, [first, ...rest]);
      const kept = leaves.flatMap((start) =>
        keptRowsSchema.parse(results[start])
      );
      for (const start of leaves) {
        left.push(...leftRowsSchema.parse(results[start + 1]));
      }
      // As Better Auth's own removal does (auth.ts): leaving a team can
      // take a role in an App away, so its open pages look again; told
      // once the batch committed, and by the clock if not now.
      // oxlint-disable-next-line no-await-in-loop
      await tellKept(env, kept);
    }
  }
  const touched = [
    ...new Set([
      ...left.map(({ teamId }) => teamId),
      ...changes.flatMap(({ after }) => (after === undefined ? [] : [after])),
    ]),
  ];
  if (touched.length > 0) {
    // Better Auth's count of each team's members, as its own writes keep it.
    await db
      .update(teams)
      .set({
        memberCount: sql`(SELECT count(*) FROM ${teamMembers} WHERE ${teamMembers.teamId} = ${teams.id})`,
      })
      .where(inList(teams.id, touched));
  }
};

/**
 * Puts the members of the list the admin last confirmed in their teams
 * (GRA-2055), from the onboarding store's confirmed places, never from a
 * request: a confirm at a time, and never an older one after a newer one.
 * It claims its version in D1 first (`staff_list_placed`), only when it is
 * newer than the one placed, reads after that claim, and writes only
 * while the claim stands: a newer confirm's claim makes the rest of an
 * older one's writes nothing, and the newer one reads what the older one
 * wrote. Placed, it looks at the store again and places a newer list, if
 * one came meanwhile, so the members' teams end as the last confirmed
 * list says.
 */
export const placePrimaries = async (
  env: Env,
  actor: AuditActor
): Promise<void> => {
  const db = drizzle(env.DB);
  const store = onboardingStore(env);
  let confirmed = await store.confirmedPlaces();
  while (confirmed !== null) {
    const { version } = confirmed;
    // oxlint-disable-next-line no-await-in-loop -- one confirmed list at a time
    const [claimed] = await db
      .insert(staffListPlaced)
      .values({ organizationId, version })
      .onConflictDoUpdate({
        target: staffListPlaced.organizationId,
        set: { version },
        setWhere: sql`${staffListPlaced.version} < ${version}`,
      })
      .returning({ version: staffListPlaced.version });
    if (claimed === undefined) {
      // This list or a newer one is placed, or being placed.
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- one confirmed list at a time
    await placeVersion(env, actor, confirmed);
    // oxlint-disable-next-line no-await-in-loop -- one confirmed list at a time
    const latest = await store.confirmedPlaces();
    confirmed = latest?.version === version ? null : latest;
  }
};
