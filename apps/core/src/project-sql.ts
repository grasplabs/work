import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { activeMember } from "./auth/membership-sql.ts";
import { projectMembers, projects, teamMembers } from "./db/core/schema.ts";

// Whom a share with a project reaches, as SQL read in the statement that
// decides (project-access.ts): apart, with nothing but the schema
// imported, since the access checks of every kind (and the revocations
// auth/auth.ts reaches) read it.

/**
 * The projects `person` (an ID, or a column holding one) is in when the
 * statement runs, as a SQL list of their IDs: the ones they own, and those
 * they are in as a person or through a team they are in then. For `IN`,
 * which needs no duplicates removed: `UNION ALL`, so the plan sorts
 * nothing (a `UNION` would, in every statement that reads it).
 */
export const projectsOfSql = (person: string | SQLiteColumn | SQL): SQL =>
  sql`(SELECT ${projects.id} FROM ${projects} WHERE ${projects.ownerId} = ${person}
    UNION ALL SELECT ${projectMembers.projectId} FROM ${projectMembers}
      WHERE (${projectMembers.memberType} = 'person' AND ${projectMembers.memberId} = ${person})
        OR (${projectMembers.memberType} = 'team' AND ${projectMembers.memberId} IN (
          SELECT ${teamMembers.teamId} FROM ${teamMembers} WHERE ${teamMembers.userId} = ${person})))`;

/**
 * That a member row (`type`, `id`, raw SQL of another table's columns)
 * shares with a project `person` is in now, as SQL: for the access checks
 * written as SQL beside their person and team rows.
 */
export const viaProjectSql = (
  type: SQL | SQLiteColumn,
  id: SQL | SQLiteColumn,
  person: string | SQLiteColumn | SQL
): SQL => sql`(${type} = 'project' AND ${id} IN ${projectsOfSql(person)})`;

/**
 * That `person` builds project `id` when the statement runs, as SQL, as
 * `rolesIn` decides it (project-access.ts): an admin of the organization,
 * or someone whose organization role builds and who owns it or is in it
 * as a builder, as a person or through a team they are in then. Every
 * write to a project checks it again in its own statement, so a builder
 * removed or demoted while a call was under way changes nothing.
 */
export const projectBuiltBySql = (id: string, person: string): SQL => sql`(
  ${activeMember(person, ["admin"])}
  OR (${activeMember(person, ["admin", "builder"])} AND (
    EXISTS (SELECT 1 FROM ${projects} WHERE ${projects.id} = ${id} AND ${projects.ownerId} = ${person})
    OR EXISTS (SELECT 1 FROM ${projectMembers}
      WHERE ${projectMembers.projectId} = ${id} AND ${projectMembers.role} = 'builder'
        AND ((${projectMembers.memberType} = 'person' AND ${projectMembers.memberId} = ${person})
          OR (${projectMembers.memberType} = 'team' AND ${projectMembers.memberId} IN (
            SELECT ${teamMembers.teamId} FROM ${teamMembers} WHERE ${teamMembers.userId} = ${person})))))))`;

/**
 * Project `id`'s ID while it is there and `by` builds it
 * (`projectBuiltBySql`); NULL otherwise. As the value a write inserts, or
 * a condition it is written under, read in its own statement, so a project
 * deleted or no longer `by`'s to build meanwhile fails the write rather
 * than let a former builder in.
 */
export const projectStillBuiltSql = (id: string, by: string): SQL =>
  sql`(SELECT ${projects.id} FROM ${projects} WHERE ${projects.id} = ${id}
    AND ${projectBuiltBySql(id, by)})`;
