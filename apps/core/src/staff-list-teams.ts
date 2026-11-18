import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import type { Roster } from "@grasp-os/shared/onboarding";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { teamAccessMayHaveDropped } from "./access-revocations.ts";
import { auditedBatch, outboxed, outboxedIfChanged } from "./audit-outbox.ts";
import { activeMember, organizationId } from "./auth/membership-sql.ts";
import { teamMembers, teamPrimaries, teams, users } from "./db/core/schema.ts";
import { chunks, inList, statementsWithin } from "./db/d1.ts";
import { teamNameKey } from "./onboarding/kickoff-company.ts";

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
// - A deleted team's id coming back with someone's history: a new team's
//   id is always core's own (`crypto.randomUUID`), never one a request
//   sent.
// - A rename splitting what one team holds: everything keys by the id.
// - A team the admin only drafted: made at the confirm, never before, so a
//   draft fixed before it leaves no team behind.

/** The directory's placeholder addresses (auth/directory-members.ts): no sign-in verified them. */
const placeholderSuffix = "%@directory.invalid";

/** How many people's changes go in one batch: six statements each at most. */
const peoplePerBatch = 50;

/** What a staff-list change records as how it was made. */
const via = "staffList";

/**
 * `roster` with each of its teams as a members' team: the one with its id,
 * else the one with its name (trimmed, any case) no other team on it took,
 * else, with `make` (the admin confirmed it), a new one, made now, and the
 * members' teams renamed to the names the list gives. A draft (`make`
 * false) writes nothing: a team new on it keeps the id it came with, in
 * the onboarding's store alone, until a confirm makes it. None is ever
 * deleted here, as one may hold what was shared with it. Answers the
 * roster as the store keeps it.
 */
export const intoMembersTeams = async (
  env: Env,
  roster: Roster,
  actor: AuditActor,
  { make }: { make: boolean }
): Promise<Roster> => {
  const db = drizzle(env.DB);
  const existing = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(eq(teams.organizationId, organizationId));
  const known = new Map(existing.map(({ id, name }) => [id, name]));
  const byName = new Map<string, string[]>();
  for (const { id, name } of existing) {
    const key = teamNameKey(name);
    byName.set(key, [...(byName.get(key) ?? []), id]);
  }
  // Ids first, then names, so a team the list holds by its id is never
  // taken by another of the list's teams through its name.
  const taken = new Set(
    roster.teams.flatMap(({ id }) => (known.has(id) ? [id] : []))
  );
  const idOf = new Map<string, string>();
  const made: { id: string; name: string }[] = [];
  for (const team of roster.teams) {
    if (known.has(team.id)) {
      idOf.set(team.id, team.id);
      continue;
    }
    const [named, ...others] = (
      byName.get(teamNameKey(team.name)) ?? []
    ).filter((id) => !taken.has(id));
    if (named !== undefined && others.length === 0) {
      taken.add(named);
      idOf.set(team.id, named);
    } else if (make) {
      const id = crypto.randomUUID();
      made.push({ id, name: team.name });
      taken.add(id);
      idOf.set(team.id, id);
    }
  }
  const renamed = roster.teams.flatMap((team) => {
    const id = idOf.get(team.id) ?? team.id;
    const was = known.get(id);
    return was !== undefined && was !== team.name
      ? [{ id, name: team.name }]
      : [];
  });
  const now = new Date();
  const entry = (
    action: string,
    id: string
  ): Pick<AuditEntry, "action" | "target" | "detail"> & {
    actor: AuditActor;
  } => ({ actor, action, target: { type: "team", id }, detail: { via } });
  const writes = [
    ...(made.length === 0
      ? []
      : statementsWithin(made, (part) =>
          db.insert(teams).values(
            part.map(({ id, name }) => ({
              id,
              name,
              organizationId,
              createdAt: now,
              updatedAt: now,
            }))
          )
        )),
    ...made.map(({ id }) => outboxed(db, entry("team.created", id))),
    ...renamed.flatMap(({ id, name }) => [
      db
        .update(teams)
        .set({ name, updatedAt: now })
        .where(and(eq(teams.id, id), eq(teams.organizationId, organizationId))),
      outboxedIfChanged(db, entry("team.updated", id)),
    ]),
  ];
  const [first, ...rest] = writes;
  if (make && first !== undefined) {
    await auditedBatch(env, db, [first, ...rest]);
  }
  return {
    teams: roster.teams.map((team) => ({
      ...team,
      id: idOf.get(team.id) ?? team.id,
    })),
    people: roster.people.map((person) => ({
      ...person,
      team: idOf.get(person.team) ?? person.team,
    })),
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
 * `before` to `after`: then it takes away the old one only if it made that
 * membership itself, never one an admin added by hand, and adds the new
 * one, recording whether it made it (an admin may have added it already).
 * While the list gives the same team, it does nothing: a membership an
 * admin took away by hand stays away, its primary row the marker of that.
 * The statements of one person go in one batch, the leave and the join of
 * a move together. None when nothing changed.
 */
export const placementOf = (
  db: DrizzleD1Database,
  actor: AuditActor,
  { userId, before, after, key }: Placement,
  now: Date
) => {
  if (before?.teamId === after) {
    return [];
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
    and(eq(teamPrimaries.userId, userId), eq(teamPrimaries.teamId, teamId));
  const leave =
    before === undefined
      ? []
      : [
          db
            .delete(teamMembers)
            .where(
              and(
                eq(teamMembers.userId, userId),
                eq(teamMembers.teamId, before.teamId),
                sql`EXISTS (SELECT 1 FROM ${teamPrimaries} WHERE ${isPrimary(before.teamId)} AND ${teamPrimaries.made} = 1)`
              )
            ),
          outboxedIfChanged(db, entry("team.member.removed", before.teamId)),
          db.delete(teamPrimaries).where(isPrimary(before.teamId)),
        ];
  if (after === undefined || key === undefined) {
    return leave;
  }
  const memberId = crypto.randomUUID();
  const isIn = sql`EXISTS (SELECT 1 FROM ${teamMembers} WHERE ${teamMembers.userId} = ${userId} AND ${teamMembers.teamId} = ${after})`;
  return [
    ...leave,
    // In one statement with the checks: someone removed, or a team
    // deleted, since the read gets nothing; nor does a membership an
    // admin added meanwhile, by its pair or Better Auth's key.
    db
      .insert(teamMembers)
      .select(
        sql`SELECT ${memberId}, ${after}, ${userId}, ${key}, ${now.getTime()}
          WHERE ${activeMember(userId)}
            AND EXISTS (SELECT 1 FROM ${teams} WHERE ${teams.id} = ${after} AND ${teams.organizationId} = ${organizationId})
            AND NOT ${isIn}`
      )
      .onConflictDoNothing(),
    outboxedIfChanged(db, entry("team.member.added", after)),
    db
      .insert(teamPrimaries)
      .select(
        sql`SELECT ${userId}, ${after}, ${now.getTime()},
            EXISTS (SELECT 1 FROM ${teamMembers} WHERE ${teamMembers.id} = ${memberId})
          WHERE ${isIn}`
      )
      .onConflictDoUpdate({
        target: teamPrimaries.userId,
        set: {
          teamId: sql`excluded.team_id`,
          placedAt: sql`excluded.placed_at`,
          made: sql`excluded.made`,
        },
      }),
  ];
};

/**
 * Puts each person on the confirmed `roster` who is a member now in their
 * team, as their primary one, found by the address their sign-in
 * verified; and moves out of the team it gave them before whoever the
 * list moved, took off, or no longer finds by their address, by the one
 * rule (`placementOf`). Each change audited.
 */
export const placePrimaries = async (
  env: Env,
  roster: Roster,
  actor: AuditActor
): Promise<void> => {
  const db = drizzle(env.DB);
  const teamOf = new Map<string, string>();
  for (const { email, team } of roster.people) {
    const address = email.toLowerCase();
    if (address !== "" && !teamOf.has(address)) {
      teamOf.set(address, team);
    }
  }
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
  // Each person's change whole in one batch: a move never ends half done.
  for (const part of chunks(changes, peoplePerBatch)) {
    const [first, ...rest] = part.flatMap((change) =>
      placementOf(db, actor, change, now)
    );
    if (first !== undefined) {
      // Batches one after another, each within D1's limits.
      // oxlint-disable-next-line no-await-in-loop
      await auditedBatch(env, db, [first, ...rest]);
    }
  }
  const touched = [
    ...new Set(
      changes.flatMap(({ before, after }) => [
        ...(before === undefined ? [] : [before.teamId]),
        ...(after === undefined ? [] : [after]),
      ])
    ),
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
  // As Better Auth's own removal does (auth.ts): leaving a team can take a
  // role in an App shared with it away, so its open pages look again.
  const left = new Map<string, string[]>();
  for (const { userId, before } of changes) {
    if (before !== undefined) {
      left.set(before.teamId, [...(left.get(before.teamId) ?? []), userId]);
    }
  }
  await Promise.all(
    [...left].map(async ([teamId, userIds]) => {
      await teamAccessMayHaveDropped(env, teamId, userIds);
    })
  );
};

/**
 * An admin added `userId` to `teamId` by hand (Settings › Members): where
 * that is the team the list gives them, the membership is theirs from now
 * on, and the list never takes it away (`placementOf`).
 */
export const addedByHand = async (
  env: Env,
  teamId: string,
  userId: string
): Promise<void> => {
  await drizzle(env.DB)
    .update(teamPrimaries)
    .set({ made: false })
    .where(
      and(eq(teamPrimaries.userId, userId), eq(teamPrimaries.teamId, teamId))
    );
};
