import { projectItemsMax, projectMembersMax } from "@grasp-os/shared/projects";
import type {
  ProjectItemRef,
  ProjectMemberRef,
} from "@grasp-os/shared/projects";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { activeMember } from "./auth/membership-sql.ts";
import {
  appMembers,
  projectItems,
  projectMembers,
  projects,
  teamMembers,
  teams,
  workflowResourceMembers,
} from "./db/core/schema.ts";

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
 * The items in project `id` when the statement runs, each once, as SQL
 * rows of `type` and `id`: those filed in it and those shared with it.
 */
const itemsOfSql = (id: string): SQL =>
  sql`SELECT ${projectItems.itemType} AS type, ${projectItems.itemId} AS id FROM ${projectItems} WHERE ${projectItems.projectId} = ${id}
    UNION SELECT 'app', ${appMembers.appId} FROM ${appMembers} WHERE ${appMembers.memberType} = 'project' AND ${appMembers.memberId} = ${id}
    UNION SELECT 'workflow', ${workflowResourceMembers.workflowResourceId} FROM ${workflowResourceMembers} WHERE ${workflowResourceMembers.memberType} = 'project' AND ${workflowResourceMembers.memberId} = ${id}`;

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
 * Project `id`'s ID while it is there, `by` builds it
 * (`projectBuiltBySql`), and it has room for `item` (`projectItemsMax`)
 * or holds it already; NULL otherwise. As the value a write inserts, or
 * a condition it is written under, read in its own statement, so a
 * project deleted, filled, or no longer `by`'s to build meanwhile fails
 * the write rather than overflow it or let a former builder in.
 */
export const projectWithRoomForItemSql = (
  id: string,
  item: ProjectItemRef,
  by: string
): SQL =>
  sql`(SELECT ${projects.id} FROM ${projects} WHERE ${projects.id} = ${id}
    AND ${projectBuiltBySql(id, by)}
    AND ((SELECT count(*) FROM (${itemsOfSql(id)})) < ${projectItemsMax}
      OR EXISTS (SELECT 1 FROM (${itemsOfSql(id)}) AS held WHERE held.type = ${item.type} AND held.id = ${item.id})))`;

/**
 * Project `id`'s ID while it is there, `by` builds it, and it has room
 * for `member` besides its owner (`projectMembersMax`); NULL otherwise.
 * It counts everyone else who is in it now, as its page lists them: people
 * still in the organization and teams that still exist (rows of those gone
 * are kept, as an App's members are, and reach nobody). So someone in it
 * may still change role at the limit.
 */
export const projectWithRoomForMemberSql = (
  id: string,
  member: ProjectMemberRef,
  by: string
): SQL =>
  sql`(SELECT ${projects.id} FROM ${projects} WHERE ${projects.id} = ${id}
    AND ${projectBuiltBySql(id, by)}
    AND (SELECT count(*) FROM ${projectMembers} WHERE ${projectMembers.projectId} = ${id}
      AND NOT (${projectMembers.memberType} = ${member.type} AND ${projectMembers.memberId} = ${member.id})
      AND ((${projectMembers.memberType} = 'person' AND ${activeMember(projectMembers.memberId)})
        OR (${projectMembers.memberType} = 'team' AND EXISTS (SELECT 1 FROM ${teams} WHERE ${teams.id} = ${projectMembers.memberId})))) < ${projectMembersMax})`;
