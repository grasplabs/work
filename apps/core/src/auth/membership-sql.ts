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
  userId: string | SQLiteColumn
): SQL => sql`NOT EXISTS (
  SELECT 1 FROM ${memberRemovals}
  WHERE ${memberRemovals.organizationId} = ${organizationId}
    AND ${memberRemovals.userId} = ${userId}
)`;

/** `members`, as `activeMember` reads it: apart from any caller's. */
const activeMembership = alias(members, "active_membership");

/**
 * That `userId` (an ID, or a column holding one) is an active member of
 * the organization now, with one of `roles` if given, as a SQL condition.
 * Its own read of `members` is aliased: a caller's column of `members`
 * (a query on members itself) is that caller's row, never this read's.
 */
export const activeMember = (
  userId: string | SQLiteColumn | SQL,
  withRoles?: readonly string[]
): SQL => sql`EXISTS (
  SELECT 1 FROM ${members} AS ${activeMembership}
  WHERE ${activeMembership.organizationId} = ${organizationId}
    AND ${activeMembership.userId} = ${userId}
    ${withRoles === undefined ? sql`` : sql`AND ${inList(activeMembership.role, withRoles)}`}
    AND ${notRemoved(activeMembership.userId)}
)`;
