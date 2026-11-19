import { createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { toBase64Url } from "@grasp-os/shared/encoding";
import { teamNameKey } from "@grasp-os/shared/onboarding";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";

import { revocationsOf } from "./access-revocations.ts";
import type { KeptRevocation } from "./access-revocations.ts";
import { auditedBatch } from "./audit-outbox.ts";
import { activeMember, organizationId } from "./auth/membership-sql.ts";
import {
  accounts,
  auditOutbox,
  directoryDepartments,
  directoryMemberships,
  directoryPeople,
  teamMembers,
  teamPins,
  teams,
} from "./db/core/schema.ts";
import { uuidSql } from "./db/d1.ts";
import type { DirectoryKind } from "./directory-ties.ts";

// Each member tied to a directory person in the team their department
// fills (GRA-2056, slice 2; the threat model is on the issue), never over
// an admin. The ways it can go wrong, and what stops each:
//
// - Someone put where an admin said not to, or taken from where an admin
//   put them: an admin's hand add or removal pins the pair (`team_pins`,
//   written in Better Auth's before hooks, auth.ts), and every statement
//   here leaves a pinned pair as it is, checked in the statement itself.
// - A membership made by hand taken away: the read takes away only the
//   memberships it made, marked as it makes them (`directory_memberships`,
//   by the membership's own key, which goes with the membership).
// - A department taken for a team it isn't: a department fills a team by
//   the team's id, linked by name once, when exactly one team has the
//   department's name and still has it as the link is written. No team is
//   ever made here; a department with none, or none at all, places nobody.
// - Someone moved out of every team: a member leaves a team the read made
//   them a member of only for another their department fills now; a
//   department cleared, or one no team is linked to, takes nobody away.
// - A change landing mid-read (a hand change, the team's deletion, the
//   member's removal or erasure): every write is decided in the statement
//   that makes it, in one batch, one transaction, from what holds then.
// - Pages still showing what someone may no longer read: a revocation is
//   kept in the batch that takes anyone out of a team, and told after.

/** How Better Auth keys a membership (its organization plugin's adapter). */
export const membershipKeyOf = async (
  teamId: string,
  userId: string
): Promise<string> =>
  toBase64Url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([teamId, userId]))
      )
    )
  );

/** A membership a placement may make: user, team, its key, the row's id. */
type Candidate = [string, string, string, string];

/** A department a read may link, the one team named as it, and that name. */
type NewLink = [string, string, string];

/** What a placement may write, as its statements' JSON values. */
export interface Placement {
  /** Every membership it may make (`Candidate`); each is checked as written. */
  candidates: string;
  /** Every department it may link (`NewLink`), likewise. */
  links: string;
}

/** `pairs` (user, team) as candidates, each with its key and a new row id. */
const candidatesOf = async (
  pairs: readonly (readonly [string, string])[]
): Promise<string> => {
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const [userId, teamId] of pairs) {
    const pair = JSON.stringify([userId, teamId]);
    if (!seen.has(pair)) {
      seen.add(pair);
      // oxlint-disable-next-line no-await-in-loop -- one digest at a time
      const key = await membershipKeyOf(teamId, userId);
      candidates.push([userId, teamId, key, crypto.randomUUID()]);
    }
  }
  return JSON.stringify(candidates);
};

/**
 * What the daily read of `kind` may place, from what holds before its
 * batch: each listed person's department, linked to a team already or by
 * name now, and the members whose sign-in names them. Only candidates: the
 * batch writes each only if it still holds as it is written.
 */
export const readPlacementOf = async (
  env: Env,
  kind: DirectoryKind,
  tenant: string,
  people: readonly { id: string; department: string }[]
): Promise<Placement> => {
  const db = drizzle(env.DB);
  const [signedIn, linked, named] = await db.batch([
    db
      .select({
        id: sql<string>`lower(${kind.signedInAs})`,
        userId: accounts.userId,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.providerId, kind.signInProvider),
          isNotNull(kind.signedInAs),
          sql`lower(${accounts.verifiedTenant}) = ${tenant}`
        )
      ),
    db
      .select({
        department: directoryDepartments.department,
        teamId: directoryDepartments.teamId,
      })
      .from(directoryDepartments)
      .where(eq(directoryDepartments.provider, kind.provider)),
    db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(eq(teams.organizationId, organizationId)),
  ]);
  const teamOf = new Map(
    linked.map(({ department, teamId }) => [department, teamId])
  );
  const byName = new Map<string, { id: string; name: string }[]>();
  for (const team of named) {
    const key = teamNameKey(team.name);
    byName.set(key, [...(byName.get(key) ?? []), team]);
  }
  const links: NewLink[] = [];
  for (const department of new Set(people.map((each) => each.department))) {
    const [team, ...others] = byName.get(teamNameKey(department)) ?? [];
    if (
      department !== "" &&
      !teamOf.has(department) &&
      team !== undefined &&
      others.length === 0
    ) {
      teamOf.set(department, team.id);
      links.push([department, team.id, team.name]);
    }
  }
  const usersOf = new Map<string, string[]>();
  for (const { id, userId } of signedIn) {
    usersOf.set(id, [...(usersOf.get(id) ?? []), userId]);
  }
  const pairs = people.flatMap(({ id, department }) => {
    const teamId = teamOf.get(department);
    return teamId === undefined
      ? []
      : (usersOf.get(id) ?? []).map((userId) => [userId, teamId] as const);
  });
  return {
    candidates: await candidatesOf(pairs),
    links: JSON.stringify(links),
  };
};

/**
 * What placing `userId` as they sign in may write: the teams the
 * departments of the directory's people tied to them fill now.
 */
const signInPlacementOf = async (
  env: Env,
  kind: DirectoryKind,
  userId: string
): Promise<Placement> => {
  const filled = await drizzle(env.DB)
    .select({ teamId: directoryDepartments.teamId })
    .from(directoryPeople)
    .innerJoin(
      directoryDepartments,
      and(
        eq(directoryDepartments.provider, directoryPeople.provider),
        eq(directoryDepartments.department, directoryPeople.department)
      )
    )
    .where(
      and(
        eq(directoryPeople.provider, kind.provider),
        eq(directoryPeople.userId, userId)
      )
    );
  return {
    candidates: await candidatesOf(
      filled.map(({ teamId }) => [userId, teamId] as const)
    ),
    links: "[]",
  };
};

/** That `kind` ties `user` to a person whose department fills `team`, as SQL. */
const filled = (kind: DirectoryKind, user: SQL, team: SQL): SQL => sql`EXISTS (
  SELECT 1 FROM ${directoryPeople}
  JOIN ${directoryDepartments}
    ON ${directoryDepartments.provider} = ${directoryPeople.provider}
    AND ${directoryDepartments.department} = ${directoryPeople.department}
  WHERE ${directoryPeople.provider} = ${kind.provider}
    AND ${directoryPeople.userId} = ${user}
    AND ${team}
)`;

/** That an admin pinned `user` in or out of `team`, as SQL. */
const pinned = (user: SQL, team: SQL): SQL => sql`EXISTS (
  SELECT 1 FROM ${teamPins}
  WHERE ${teamPins.userId} = ${user} AND ${teamPins.teamId} = ${team}
)`;

/** An audit entry the read records for each row, its ids filled in by SQL. */
const systemEntry = (action: string, detail: AuditEntry["detail"]) =>
  JSON.stringify(
    createAuditEvent(
      {
        actor: { type: "system" },
        action,
        target: { type: "team", id: "team" },
        ...(detail === undefined ? {} : { detail }),
      },
      "core"
    )
  );

/**
 * The statements that place `kind`'s tied members as `placement` and what
 * holds when each runs say, taking out only members `scope` (on
 * `team_members.user_id`) names. Each reads what the directory's rows
 * hold as it runs, and changes nothing a second run would change again,
 * so a read that lost its claim (directory-people.ts) places as the one
 * that holds it. In order: the departments linked by name; the memberships
 * made, each recorded and marked as the read's; those the read made that a
 * member's department no longer fills, recorded, a revocation kept, and
 * taken away; the touched teams' counts. The revocation it keeps is the
 * answer of the statement at `revocation`, for the caller to tell
 * (`keptIn`).
 */
export const placementStatements = (
  db: DrizzleD1Database,
  kind: DirectoryKind,
  placement: Placement,
  scope: SQL
): { statements: BatchItem<"sqlite">[]; revocation: number } => {
  const { candidates, links } = placement;
  const now = Date.now();
  const user = sql`value ->> 0`;
  const team = sql`value ->> 1`;
  const linkable = sql`NOT EXISTS (
      SELECT 1 FROM ${directoryDepartments}
      WHERE ${directoryDepartments.provider} = ${kind.provider}
        AND ${directoryDepartments.department} = value ->> 0
    )
    AND EXISTS (
      SELECT 1 FROM ${teams} WHERE ${teams.id} = value ->> 1 AND ${teams.name} = value ->> 2
    )`;
  // A link names only a team that exists, which takes its links with it.
  // A tie names an active member, but at sign-in the tie is a batch of its
  // own: whether they still are one is asked again here.
  const joinable = sql`${filled(kind, user, sql`${directoryDepartments.teamId} = ${team}`)}
    AND ${activeMember(user)}
    AND NOT ${pinned(user, team)}
    AND NOT EXISTS (
      SELECT 1 FROM ${teamMembers}
      WHERE ${teamMembers.teamId} = ${team} AND ${teamMembers.userId} = ${user}
    )`;
  const leavable = sql`${teamMembers.membershipKey} IN (
      SELECT ${directoryMemberships.membershipKey} FROM ${directoryMemberships}
    )
    AND NOT ${filled(kind, sql`${teamMembers.userId}`, sql`${directoryDepartments.teamId} = ${teamMembers.teamId}`)}
    AND ${filled(kind, sql`${teamMembers.userId}`, sql`${directoryDepartments.teamId} <> ${teamMembers.teamId}`)}
    AND NOT ${pinned(sql`${teamMembers.userId}`, sql`${teamMembers.teamId}`)}
    AND ${scope}`;
  const linked = systemEntry("directory.department_linked", {
    provider: kind.provider,
  });
  const added = systemEntry("team.member.added", {
    userId: "user",
    via: "directory",
  });
  const removed = systemEntry("team.member.removed", {
    userId: "user",
    via: "directory",
  });
  const kept = revocationsOf(
    db,
    undefined,
    null,
    sql`EXISTS (SELECT 1 FROM ${teamMembers} WHERE ${leavable})`
  );
  const statements: BatchItem<"sqlite">[] = [
    db.insert(auditOutbox).select(
      sql`SELECT id, json_set(${linked}, '$.id', id, '$.target.id', value ->> 1), ${now}
        FROM (SELECT ${uuidSql} AS id, value FROM json_each(${links}) WHERE ${linkable})`
    ),
    db
      .insert(directoryDepartments)
      .select(
        sql`SELECT ${kind.provider}, value ->> 0, value ->> 1 FROM json_each(${links}) WHERE ${linkable}`
      )
      .onConflictDoNothing(),
    db.insert(auditOutbox).select(
      sql`SELECT id, json_set(${added}, '$.id', id, '$.target.id', value ->> 1, '$.detail.userId', value ->> 0), ${now}
        FROM (SELECT ${uuidSql} AS id, value FROM json_each(${candidates}) WHERE ${joinable})`
    ),
    db
      .insert(teamMembers)
      .select(
        sql`SELECT value ->> 3, value ->> 1, value ->> 0, value ->> 2, ${now}
          FROM json_each(${candidates}) WHERE ${joinable}`
      )
      .onConflictDoNothing(),
    // Marked only where this batch's own insert made the membership: its
    // row holds the id the candidate gave it.
    db
      .insert(directoryMemberships)
      .select(
        sql`SELECT value ->> 2 FROM json_each(${candidates})
          WHERE EXISTS (SELECT 1 FROM ${teamMembers} WHERE ${teamMembers.id} = value ->> 3)`
      )
      .onConflictDoNothing(),
    db.insert(auditOutbox).select(
      sql`SELECT id, json_set(${removed}, '$.id', id, '$.target.id', team_id, '$.detail.userId', user_id), ${now}
        FROM (
          SELECT ${uuidSql} AS id, ${teamMembers.teamId} AS team_id, ${teamMembers.userId} AS user_id
          FROM ${teamMembers} WHERE ${leavable}
        )`
    ),
    kept,
    db.delete(teamMembers).where(leavable),
    db
      .update(teams)
      .set({
        memberCount: sql`(SELECT count(*) FROM ${teamMembers} WHERE ${teamMembers.teamId} = ${teams.id})`,
      })
      .where(eq(teams.organizationId, organizationId)),
  ];
  return { statements, revocation: statements.indexOf(kept) };
};

/** A row `revocationsOf` answers. */
const isKept = (row: unknown): row is KeptRevocation =>
  typeof row === "object" && row !== null && "appId" in row && "userIds" in row;

/** The revocations the statement at `revocation` answered with. */
export const keptIn = (result: unknown): KeptRevocation[] =>
  Array.isArray(result) ? result.filter(isKept) : [];

/**
 * Places `userId`, who is signing in, by the read's own statements, for
 * them alone: in the teams their directory people's departments fill.
 * Answers the revocations its batch kept, for the caller to tell.
 */
export const placeSignedIn = async (
  env: Env,
  kind: DirectoryKind,
  userId: string
): Promise<KeptRevocation[]> => {
  const placement = await signInPlacementOf(env, kind, userId);
  const db = drizzle(env.DB);
  const { statements, revocation } = placementStatements(
    db,
    kind,
    placement,
    sql`${teamMembers.userId} = ${userId}`
  );
  const [first, ...rest] = statements;
  if (first === undefined) {
    return [];
  }
  const results: unknown[] = await auditedBatch(env, db, [first, ...rest]);
  return keptIn(results[revocation]);
};

/**
 * Pins `userId` in `teamId` (`kept`) or out of it, as an admin's hand add
 * or removal does, in Better Auth's before hook of that route (auth.ts),
 * ahead of its own change: whichever lands first, the read's statements
 * see the pin and leave the pair as the admin set it.
 */
export const pinTeamMember = async (
  env: Env,
  teamId: string,
  userId: string,
  kept: boolean
): Promise<void> => {
  const pinnedAt = new Date();
  await drizzle(env.DB)
    .insert(teamPins)
    .values({ teamId, userId, kept, pinnedAt })
    .onConflictDoUpdate({
      target: [teamPins.userId, teamPins.teamId],
      set: { kept, pinnedAt },
    });
};
