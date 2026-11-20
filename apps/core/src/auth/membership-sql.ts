import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { memberRemovals, members } from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";

// Who is a member of the organization now, as SQL: apart from auth.ts,
// which reaches the access revocations, so the access checks those read
// (project-sql.ts) can use it without a cycle.

/** The deployment's one organization, created on the first sign-in. */
export const organizationId = "organization";

/**
 * That an admin hasn't removed `userId` (an ID, or the column holding one)
 * from the organization, as a SQL condition. A removal is kept after the
 * membership goes, so every read and write of a membership checks it:
 * nothing brings a removed person back.
 */
export const notRemoved = (
  userId: string | SQLiteColumn | SQL
): SQL => sql`NOT EXISTS (
  SELECT 1 FROM ${memberRemovals}
  WHERE ${memberRemovals.organizationId} = ${organizationId}
    AND ${memberRemovals.userId} = ${userId}
)`;

/** `members`, as `mayAct` reads it for a suspension: apart from any caller's. */
const suspendedMembership = alias(members, "suspended_membership");

/**
 * That `userId` (an ID, or a column holding one) may act, and be read as,
 * in the organization now, as a SQL condition: the one check everything
 * that decides so shares (sign-in, every RPC, Apps, agents and workflows
 * acting for them, Teams and Slack, the counts of a team's people).
 * Neither removed by an admin (`notRemoved`, which alone serves removal
 * itself, erasure's "removed first" and the directory's tie) nor
 * suspended (`members.suspended_at`, directory-suspensions.ts).
 */
export const mayAct = (userId: string | SQLiteColumn | SQL): SQL =>
  sql`${notRemoved(userId)} AND NOT EXISTS (
    SELECT 1 FROM ${members} AS ${suspendedMembership}
    WHERE ${suspendedMembership.organizationId} = ${organizationId}
      AND ${suspendedMembership.userId} = ${userId}
      AND ${suspendedMembership.suspendedAt} IS NOT NULL
  )`;

/** `members`, as `activeMember` reads it: apart from any caller's. */
const activeMembership = alias(members, "active_membership");

/**
 * That `userId` (an ID, or a column holding one) is a member of the
 * organization, with one of `roles` if given, while `standing` holds of
 * them, as a SQL condition. Its own read of `members` is aliased: a
 * caller's column of `members` (a query on members itself) is that
 * caller's row, never this read's.
 */
const memberWhile = (
  userId: string | SQLiteColumn | SQL,
  withRoles: readonly string[] | undefined,
  standing: (user: SQLiteColumn) => SQL
): SQL => sql`EXISTS (
  SELECT 1 FROM ${members} AS ${activeMembership}
  WHERE ${activeMembership.organizationId} = ${organizationId}
    AND ${activeMembership.userId} = ${userId}
    ${withRoles === undefined ? sql`` : sql`AND ${inList(activeMembership.role, withRoles)}`}
    AND ${standing(activeMembership.userId)}
)`;

/**
 * That `userId` is a member who may act now (`mayAct`), with one of
 * `roles` if given, as a SQL condition.
 */
export const activeMember = (
  userId: string | SQLiteColumn | SQL,
  withRoles?: readonly string[]
): SQL => memberWhile(userId, withRoles, mayAct);

/**
 * That `userId` is a member an admin hasn't removed, whether or not they
 * may act now, as a SQL condition: for removal itself and the directory's
 * tie (`notRemoved`).
 */
export const memberNotRemoved = (
  userId: string | SQLiteColumn | SQL,
  withRoles?: readonly string[]
): SQL => memberWhile(userId, withRoles, notRemoved);
