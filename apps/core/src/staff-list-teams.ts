import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import type { Roster } from "@grasp-os/shared/onboarding";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

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
// - A deleted team's id coming back with someone's history: a new team's
//   id is always core's own (`crypto.randomUUID`), never one a request
//   sent.
// - A rename splitting what one team holds: everything keys by the id.
// - A move half done (the store saved, the write here failed): every
//   confirm reconciles against `team_primaries`, so the old team's access
//   goes at the next one rather than staying.
// - Someone an admin added to a team by hand: not a primary, never touched.

/** The directory's placeholder addresses (auth/directory-members.ts): no sign-in verified them. */
const placeholderSuffix = "%@directory.invalid";

/** How many people's changes go in one batch: three statements each. */
const peoplePerBatch = 50;

/** What a staff-list change records as how it was made. */
const via = "staffList";

/**
 * `roster` with each of its teams as a members' team: the one with its id,
 * else the one with its name (trimmed, any case) no other team on it took,
 * else a new one, made now. The members' teams are renamed to the names
 * the list gives; none is ever deleted here, as one may hold what was
 * shared with it. Answers the roster as the store keeps it: under the
 * members' teams' ids.
 */
export const intoMembersTeams = async (
  env: Env,
  roster: Roster,
  actor: AuditActor
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
    const id =
      named !== undefined && others.length === 0 ? named : crypto.randomUUID();
    if (id !== named) {
      made.push({ id, name: team.name });
    }
    taken.add(id);
    idOf.set(team.id, id);
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
  if (first !== undefined) {
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
 * Puts each person on the confirmed `roster` who is a member now in their
 * team, as their primary one, found by the address their sign-in
 * verified; and takes everyone out of a primary team the list no longer
 * gives them (moved, taken off, their address changed), with that
 * membership. Teams an admin added someone to by hand stay as they are.
 * Reconciles against what the list placed before, so a confirm whose
 * write here failed is put right by the next. Each change audited.
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
      .select({ userId: teamPrimaries.userId, teamId: teamPrimaries.teamId })
      .from(teamPrimaries),
  ]);
  const wanted = new Map<string, string>();
  for (const { id, email } of found) {
    const team = teamOf.get(email.toLowerCase());
    if (team !== undefined) {
      wanted.set(id, team);
    }
  }
  const was = new Map(placed.map(({ userId, teamId }) => [userId, teamId]));
  const memberships = await db
    .select({ userId: teamMembers.userId, teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(inList(teamMembers.userId, [...wanted.keys()]));
  const isIn = new Set(
    memberships.map(({ userId, teamId }) => `${userId} ${teamId}`)
  );
  const now = new Date();
  const entry = (
    action: "team.member.added" | "team.member.removed",
    userId: string,
    teamId: string
  ): AuditEntry => ({
    actor,
    action,
    target: { type: "team", id: teamId },
    detail: { userId, via },
  });
  const leaving = [...was].filter(
    ([userId, teamId]) => wanted.get(userId) !== teamId
  );
  const joining = [...wanted].filter(
    ([userId, teamId]) =>
      was.get(userId) !== teamId || !isIn.has(`${userId} ${teamId}`)
  );
  const groups = [
    ...leaving.map(([userId, teamId]) => [
      db
        .delete(teamMembers)
        .where(
          and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId))
        ),
      outboxedIfChanged(db, entry("team.member.removed", userId, teamId)),
      db
        .delete(teamPrimaries)
        .where(
          and(
            eq(teamPrimaries.userId, userId),
            eq(teamPrimaries.teamId, teamId)
          )
        ),
    ]),
    ...joining.map(([userId, teamId]) => [
      // In one statement with the checks: someone removed, or a team
      // deleted, since the read gets nothing.
      db.insert(teamMembers).select(
        sql`SELECT ${crypto.randomUUID()}, ${teamId}, ${userId}, NULL, ${now.getTime()}
          WHERE ${activeMember(userId)}
            AND EXISTS (SELECT 1 FROM ${teams} WHERE ${teams.id} = ${teamId} AND ${teams.organizationId} = ${organizationId})
            AND NOT EXISTS (SELECT 1 FROM ${teamMembers} WHERE ${teamMembers.userId} = ${userId} AND ${teamMembers.teamId} = ${teamId})`
      ),
      outboxedIfChanged(db, entry("team.member.added", userId, teamId)),
      db
        .insert(teamPrimaries)
        .select(
          sql`SELECT ${userId}, ${teamId}, ${now.getTime()}
            WHERE EXISTS (SELECT 1 FROM ${teamMembers} WHERE ${teamMembers.userId} = ${userId} AND ${teamMembers.teamId} = ${teamId})`
        )
        .onConflictDoUpdate({
          target: teamPrimaries.userId,
          set: { teamId: sql`excluded.team_id`, placedAt: now },
        }),
    ]),
  ];
  // Each person's change whole in one batch: a later batch that fails
  // leaves the earlier ones, which the next confirm builds on.
  for (const part of chunks(groups, peoplePerBatch)) {
    const [first, ...rest] = part.flat();
    if (first !== undefined) {
      // Batches one after another, each within D1's limits.
      // oxlint-disable-next-line no-await-in-loop
      await auditedBatch(env, db, [first, ...rest]);
    }
  }
  const touched = [
    ...new Set([...leaving, ...joining].map(([, teamId]) => teamId)),
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
  for (const [userId, teamId] of leaving) {
    left.set(teamId, [...(left.get(teamId) ?? []), userId]);
  }
  await Promise.all(
    [...left].map(async ([teamId, userIds]) => {
      await teamAccessMayHaveDropped(env, teamId, userIds);
    })
  );
};
