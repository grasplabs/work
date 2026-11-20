import { createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { toBase64Url } from "@grasp-os/shared/encoding";
import { teamNameKey } from "@grasp-os/shared/onboarding";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";
import { alias } from "drizzle-orm/sqlite-core";

import { revocationsOf } from "./access-revocations.ts";
import type { KeptRevocation } from "./access-revocations.ts";
import { auditedBatch } from "./audit-outbox.ts";
import type { Made } from "./auth/directory-members.ts";
import { activeMember, organizationId } from "./auth/membership-sql.ts";
import {
  accounts,
  auditOutbox,
  directoryDepartments,
  directoryGroupMembers,
  directoryGroupTeams,
  directoryMemberships,
  directoryPeople,
  teamMembers,
  teamPins,
  teams,
} from "./db/core/schema.ts";
import { uuidSql } from "./db/d1.ts";
import type { GroupRead } from "./directory-group-reads.ts";
import { namingAccount } from "./directory-ties.ts";
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
//   department's name and still has it as the link is written, or by an
//   admin by hand (GRA-2247, members.ts `linkDepartment`), which the read
//   never overwrites. No team is ever made here; a department with none,
//   or none at all, places nobody.
// - Someone moved out of every team: a member leaves a team the read made
//   them a member of only for another their department fills now; a
//   department cleared, or one no team is linked to, takes nobody away.
// - A change landing mid-read (a hand change, the team's deletion, the
//   member's removal or erasure): every write is decided in the statement
//   that makes it, in one batch, one transaction, from what holds then.
// - Pages still showing what someone may no longer read: a revocation is
//   kept in the batch that takes anyone out of a team, and told after.
// - A team that follows directory groups (G3, directory-group-reads.ts):
//   a team with a mapped group the read read whole follows its groups, and
//   no department fills it. Its members are those its groups list; a
//   membership the read made goes when none of them lists the person any
//   more, since a group's ID is stable, unlike a department's text. A
//   group the read held changes nothing.

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

/**
 * What a placement may write, as its statements' JSON values, each within
 * what D1 takes in one (`jsonValuesOf`).
 */
export interface Placement {
  /** Every membership it may make (`Candidate`); each is checked as written. */
  candidates: string[];
  /** Every department it may link (`NewLink`), likewise. */
  links: string[];
  /**
   * Everyone it may make a member to place (`Made`), as their candidates
   * name them: listed on, placed in a team, and named by no account yet.
   * Made only where no account names them as the batch runs, and kept
   * only where its own join placed them (directory-people.ts).
   */
  made: string[];
}

/** The most D1 takes in one value (its limits page: "Maximum string, BLOB or table row size"). */
const d1ValueBytes = 2_000_000;

/**
 * `items` as JSON arrays, as few as fit, each at most `d1ValueBytes` of
 * UTF-8: one statement each, in the one batch.
 */
export const jsonValuesOf = (items: readonly unknown[]): string[] => {
  const values: string[] = [];
  let parts: string[] = [];
  // The brackets.
  let bytes = 2;
  for (const item of items) {
    const part = JSON.stringify(item);
    // The item and the comma before it.
    const size = new TextEncoder().encode(part).length + 1;
    if (parts.length > 0 && bytes + size > d1ValueBytes) {
      values.push(`[${parts.join(",")}]`);
      parts = [];
      bytes = 2;
    }
    parts.push(part);
    bytes += size;
  }
  return parts.length === 0 ? [] : [...values, `[${parts.join(",")}]`];
};

/** `pairs` (user, team) as candidates, each with its key and a new row id. */
const candidatesOf = async (
  pairs: readonly (readonly [string, string])[]
): Promise<string[]> => {
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
  return jsonValuesOf(candidates);
};

/**
 * What the daily read of `kind` may place, from what holds before its
 * batch: each listed person's department, linked to a team already or by
 * name now, each group read whole's members in its team (`groups`), and
 * the members whose accounts name them (`namingAccount`), in any tenant;
 * or, for someone it places whom no account names, a member to make
 * (GRA-2156), by a new user ID. Only candidates: the batch writes each
 * only if it still holds as it is written, the tie's tenant among it.
 */
export const readPlacementOf = async (
  env: Env,
  kind: DirectoryKind,
  people: readonly { id: string; department: string; name: string }[],
  groups: readonly GroupRead[]
): Promise<Placement> => {
  const db = drizzle(env.DB);
  const [signedIn, linked, named] = await db.batch([
    db
      .select({
        id: sql<string>`lower(${kind.signedInAs})`,
        userId: accounts.userId,
      })
      .from(accounts)
      .where(and(namingAccount(kind), isNotNull(kind.signedInAs))),
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
  const nameOf = new Map(people.map(({ id, name }) => [id, name]));
  const made = new Map<string, Made>();
  /**
   * The pairs that place the person with provider ID `id` in `teamId`:
   * each member an account of theirs names, or one made for them, if the
   * read lists them on (`people`; never a turned-off account a group
   * lists) and `kind` makes members ahead of sign-in. Every placement of
   * the read goes through it, so whom the read places, and only they, are
   * made members ahead of their sign-in.
   */
  const placedIn = (id: string, teamId: string) => {
    const known = usersOf.get(id);
    if (known !== undefined) {
      return known.map((userId) => [userId, teamId] as const);
    }
    if (kind.madeProvider === null || !nameOf.has(id)) {
      return [];
    }
    const entry = made.get(id) ?? [
      id,
      crypto.randomUUID(),
      nameOf.get(id) ?? "",
    ];
    made.set(id, entry);
    return [[entry[1], teamId] as const];
  };
  const pairs = [
    ...people.flatMap(({ id, department }) => {
      const teamId = teamOf.get(department);
      return teamId === undefined ? [] : placedIn(id, teamId);
    }),
    ...groups.flatMap(({ teamId, users }) =>
      users.flatMap((id) => placedIn(id, teamId))
    ),
  ];
  return {
    candidates: await candidatesOf(pairs),
    links: jsonValuesOf(links),
    made: jsonValuesOf([...made.values()]),
  };
};

/**
 * What placing `userId` as they sign in may write: the teams the
 * departments of the directory's people tied to them fill now, and the
 * teams of the groups that list them.
 */
const memberPlacementOf = async (
  env: Env,
  kind: DirectoryKind,
  userId: string
): Promise<Placement> => {
  const db = drizzle(env.DB);
  const tied = and(
    eq(directoryPeople.provider, kind.provider),
    eq(directoryPeople.userId, userId)
  );
  const [filled, grouped] = await db.batch([
    db
      .select({ teamId: directoryDepartments.teamId })
      .from(directoryPeople)
      .innerJoin(
        directoryDepartments,
        and(
          eq(directoryDepartments.provider, directoryPeople.provider),
          eq(directoryDepartments.department, directoryPeople.department)
        )
      )
      .where(tied),
    db
      .select({ teamId: directoryGroupTeams.teamId })
      .from(directoryPeople)
      .innerJoin(
        directoryGroupMembers,
        and(
          eq(directoryGroupMembers.provider, directoryPeople.provider),
          eq(directoryGroupMembers.tenant, directoryPeople.tenant),
          eq(directoryGroupMembers.accountId, directoryPeople.accountId)
        )
      )
      .innerJoin(
        directoryGroupTeams,
        and(
          eq(directoryGroupTeams.provider, directoryGroupMembers.provider),
          eq(directoryGroupTeams.groupId, directoryGroupMembers.groupId)
        )
      )
      .where(and(tied, isNotNull(directoryGroupTeams.readAt))),
  ]);
  return {
    candidates: await candidatesOf(
      [...filled, ...grouped].map(({ teamId }) => [userId, teamId] as const)
    ),
    links: [],
    made: [],
  };
};

/**
 * That `team` follows the directory's groups, as SQL: a group mapped to
 * it was read whole since. No department fills such a team.
 */
export const followsGroups = (
  kind: DirectoryKind,
  team: SQL
): SQL => sql`EXISTS (
  SELECT 1 FROM ${directoryGroupTeams}
  WHERE ${directoryGroupTeams.provider} = ${kind.provider}
    AND ${directoryGroupTeams.teamId} = ${team}
    AND ${directoryGroupTeams.readAt} IS NOT NULL
)`;

/**
 * That `kind` ties `user` to a person a group of `team`'s lists, that
 * group read whole since it was mapped to `team`, as SQL.
 */
const grouped = (kind: DirectoryKind, user: SQL, team: SQL): SQL => sql`EXISTS (
  SELECT 1 FROM ${directoryPeople}
  JOIN ${directoryGroupMembers}
    ON ${directoryGroupMembers.provider} = ${directoryPeople.provider}
    AND ${directoryGroupMembers.tenant} = ${directoryPeople.tenant}
    AND ${directoryGroupMembers.accountId} = ${directoryPeople.accountId}
  JOIN ${directoryGroupTeams}
    ON ${directoryGroupTeams.provider} = ${directoryGroupMembers.provider}
    AND ${directoryGroupTeams.groupId} = ${directoryGroupMembers.groupId}
  WHERE ${directoryPeople.provider} = ${kind.provider}
    AND ${directoryPeople.userId} = ${user}
    AND ${directoryGroupTeams.teamId} = ${team}
    AND ${directoryGroupTeams.readAt} IS NOT NULL
)`;

/**
 * That `kind` ties `user` to a person whose department fills a team
 * `team` names (a condition on `directory_departments.team_id`), one that
 * doesn't follow groups, as SQL.
 */
const filled = (kind: DirectoryKind, user: SQL, team: SQL): SQL => sql`EXISTS (
  SELECT 1 FROM ${directoryPeople}
  JOIN ${directoryDepartments}
    ON ${directoryDepartments.provider} = ${directoryPeople.provider}
    AND ${directoryDepartments.department} = ${directoryPeople.department}
  WHERE ${directoryPeople.provider} = ${kind.provider}
    AND ${directoryPeople.userId} = ${user}
    AND ${team}
    AND NOT ${followsGroups(kind, sql`${directoryDepartments.teamId}`)}
)`;

/**
 * That the directory, as `kind`'s read holds it, wants `user` in `team`,
 * as SQL: a group of `team`'s lists them, or, for a team that doesn't
 * follow groups, their department fills it. The read joins whom it wants
 * (`placementStatements`); Settings shows whom it put in a team it no
 * longer wants them in (directory-placement.ts).
 */
export const directoryWants = (
  kind: DirectoryKind,
  user: SQL,
  team: SQL
): SQL => sql`(${filled(kind, user, sql`${directoryDepartments.teamId} = ${team}`)}
  OR ${grouped(kind, user, team)})`;

/**
 * That an admin kept `user` in `team` by hand (`kept`), or out of it, as
 * SQL. Each pin stops only the step that would undo the admin's change:
 * kept out, the read never adds them; kept in, it never takes them out.
 * So a pin whose hand change didn't happen after all (Better Auth's write
 * failed after its before hook, which runs no after hook on an unexpected
 * error) never stops the read doing what the admin asked for.
 */
const pinned = (user: SQL, team: SQL, kept: boolean): SQL => sql`EXISTS (
  SELECT 1 FROM ${teamPins}
  WHERE ${teamPins.userId} = ${user} AND ${teamPins.teamId} = ${team}
    AND ${teamPins.kept} = ${kept ? 1 : 0}
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

/** `team_members` again, for a member's other membership. */
const replacement = alias(teamMembers, "replacement");

/**
 * The statements that place `kind`'s tied members as `placement` and what
 * holds when each runs say, taking out only members `scope` (on
 * `team_members.user_id`) names, and linking departments only while
 * `linking` holds (a read's claim: its list of departments is its own). Each reads what the directory's rows
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
  scope: SQL,
  linking: SQL
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
    )
    AND ${linking}`;
  // A link names only a team that exists, which takes its links with it.
  // A tie names an active member, but at sign-in the tie is a batch of its
  // own: whether they still are one is asked again here.
  const joinable = sql`${directoryWants(kind, user, team)}
    AND ${activeMember(user)}
    AND NOT ${pinned(user, team, false)}
    AND NOT EXISTS (
      SELECT 1 FROM ${teamMembers}
      WHERE ${teamMembers.teamId} = ${team} AND ${teamMembers.userId} = ${user}
    )`;
  // A member leaves a team the read made them a member of: one that
  // follows groups once none of its groups lists them; one that follows
  // its department only once they are in the one their department fills
  // now, at this point in the same batch, never into no team at all.
  const member = sql`${teamMembers.userId}`;
  const memberTeam = sql`${teamMembers.teamId}`;
  const leavable = sql`${teamMembers.membershipKey} IN (
      SELECT ${directoryMemberships.membershipKey} FROM ${directoryMemberships}
    )
    AND (
      (${followsGroups(kind, memberTeam)} AND NOT ${grouped(kind, member, memberTeam)})
      OR (NOT ${followsGroups(kind, memberTeam)}
        AND NOT ${filled(kind, member, sql`${directoryDepartments.teamId} = ${teamMembers.teamId}`)}
        AND ${filled(
          kind,
          member,
          sql`${directoryDepartments.teamId} <> ${teamMembers.teamId} AND EXISTS (
            SELECT 1 FROM ${teamMembers} AS ${replacement}
            WHERE ${replacement.userId} = ${teamMembers.userId}
              AND ${replacement.teamId} = ${directoryDepartments.teamId}
          )`
        )})
    )
    AND NOT ${pinned(sql`${teamMembers.userId}`, sql`${teamMembers.teamId}`, true)}
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
    ...links.flatMap((value) => [
      db.insert(auditOutbox).select(
        sql`SELECT id, json_set(${linked}, '$.id', id, '$.target.id', value ->> 1), ${now}
          FROM (SELECT ${uuidSql} AS id, value FROM json_each(${value}) WHERE ${linkable})`
      ),
      db
        .insert(directoryDepartments)
        .select(
          sql`SELECT ${kind.provider}, value ->> 0, value ->> 1, 0 FROM json_each(${value}) WHERE ${linkable}`
        )
        .onConflictDoNothing(),
    ]),
    ...candidates.flatMap((value) => [
      db.insert(auditOutbox).select(
        sql`SELECT id, json_set(${added}, '$.id', id, '$.target.id', value ->> 1, '$.detail.userId', value ->> 0), ${now}
          FROM (SELECT ${uuidSql} AS id, value FROM json_each(${value}) WHERE ${joinable})`
      ),
      db
        .insert(teamMembers)
        .select(
          sql`SELECT value ->> 3, value ->> 1, value ->> 0, value ->> 2, ${now}
            FROM json_each(${value}) WHERE ${joinable}`
        )
        .onConflictDoNothing(),
      // Marked only where this batch's own insert made the membership: its
      // row holds the id the candidate gave it.
      db
        .insert(directoryMemberships)
        .select(
          sql`SELECT value ->> 2 FROM json_each(${value})
            WHERE EXISTS (SELECT 1 FROM ${teamMembers} WHERE ${teamMembers.id} = value ->> 3)`
        )
        .onConflictDoNothing(),
    ]),
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
 * Places `userId` by the read's own statements, for them alone, as they
 * sign in: in the teams their directory people's departments fill. Whom a
 * read's snapshot didn't know yet (signed in between it and its batch)
 * this placed already; the read leaves them where it put them, and the
 * next read moves them. Answers the revocations its batch kept, for the
 * caller to tell.
 */
export const placeMember = async (
  env: Env,
  kind: DirectoryKind,
  userId: string
): Promise<KeptRevocation[]> => {
  const placement = await memberPlacementOf(env, kind, userId);
  const db = drizzle(env.DB);
  const { statements, revocation } = placementStatements(
    db,
    kind,
    placement,
    sql`${teamMembers.userId} = ${userId}`,
    sql`0`
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
  // Only while they are a member, in the statement: a removal landing
  // after Better Auth checked it leaves nothing of them here.
  await drizzle(env.DB)
    .insert(teamPins)
    .select(
      sql`SELECT ${teamId}, ${userId}, ${kept ? 1 : 0}, ${pinnedAt.getTime()}
        WHERE ${activeMember(userId)}`
    )
    .onConflictDoUpdate({
      target: [teamPins.userId, teamPins.teamId],
      set: { kept, pinnedAt },
    });
};
