import { projectErrors } from "@grasp-os/shared/projects";
import type { ProjectRole } from "@grasp-os/shared/projects";
import { canBuild, isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, eq, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { activeMember } from "./auth/auth.ts";
import { projectMembers, projects, teamMembers } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { projectBuiltBySql } from "./project-sql.ts";

// Who is in a project, and in which role (projects.ts). A project is open
// to:
//
// - the organization's admins, who manage every project, as builders;
// - its owner, who made it, as a builder while their organization role
//   builds (only builders make projects; one demoted keeps seeing it);
// - the people and teams in it (`project_members`), in their role there;
//   someone in it twice (as a person and through a team) has the highest,
//   and only someone whose organization role builds is ever a builder.
//
// Everyone else has no role in it, and it doesn't exist for them
// (`project.not_found`), name included.
//
// Being in a project is what an App's or workflow's `project` member row
// reaches (sharing.ts): never what is merely filed in it. That row is read
// against `project_members` and `team_members` in the statement that
// decides (`projectsOfSql`, project-sql.ts), so whoever leaves a project, or a team in it,
// loses what it reached on their next call.

/** Who asks, as far as their role in a project goes. */
export type Person = Pick<Identity, "userId" | "role" | "teams">;

/** A project's ID, as core makes them. */
export const projectIdSchema = z.uuid();

/** A project as access reads it. */
export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  icon: string;
  ownerId: string;
  createdAt: Date;
}

/**
 * `by`'s role in each of `found`, by project ID, in one read: builder for
 * an admin; for its owner, and for whom it holds rows (their own, their
 * teams'), the highest, capped by their organization role, as an App's
 * roles are (`ceilingOf`): only someone whose role builds ever builds a
 * project, its owner included. A project they have no role in has no
 * entry.
 */
export const rolesIn = async (
  env: Pick<Env, "DB">,
  by: Person,
  found: readonly Pick<ProjectRow, "id" | "ownerId">[]
): Promise<Map<string, ProjectRole>> => {
  const roles = new Map<string, ProjectRole>();
  if (isAdmin(by.role)) {
    for (const { id } of found) {
      roles.set(id, "builder");
    }
    return roles;
  }
  const ceiling: ProjectRole = canBuild(by.role) ? "builder" : "user";
  const teams = by.teams.map(({ id }) => id);
  const rows =
    found.length === 0
      ? []
      : await drizzle(env.DB)
          .select({
            projectId: projectMembers.projectId,
            role: projectMembers.role,
          })
          .from(projectMembers)
          .where(
            and(
              inList(
                projectMembers.projectId,
                found.map(({ id }) => id)
              ),
              or(
                and(
                  eq(projectMembers.memberType, "person"),
                  eq(projectMembers.memberId, by.userId)
                ),
                teams.length === 0
                  ? undefined
                  : and(
                      eq(projectMembers.memberType, "team"),
                      inList(projectMembers.memberId, teams)
                    )
              )
            )
          );
  for (const { id, ownerId } of found) {
    const own = rows.filter(({ projectId }) => projectId === id);
    if (ownerId !== by.userId && own.length === 0) {
      continue;
    }
    const builds =
      ownerId === by.userId || own.some(({ role }) => role === "builder");
    roles.set(id, builds ? ceiling : "user");
  }
  return roles;
};

/** `by`'s role in `project` (`rolesIn`); undefined when they have none. */
export const roleIn = async (
  env: Pick<Env, "DB">,
  by: Person,
  project: Pick<ProjectRow, "id" | "ownerId">
): Promise<ProjectRole | undefined> => {
  const roles = await rolesIn(env, by, [project]);
  return roles.get(project.id);
};

/**
 * The project `id` names, with `by`'s role in it, refusing one they have
 * no role in (or that isn't there) with `project.not_found`, and too low a
 * role with `role.forbidden`.
 */
export const requireProjectRole = async (
  env: Pick<Env, "DB">,
  by: Person,
  id: unknown,
  needed: ProjectRole
): Promise<{ project: ProjectRow; role: ProjectRole }> => {
  const parsed = projectIdSchema.safeParse(id);
  if (!parsed.success) {
    throw projectErrors.create("project.not_found");
  }
  const project = await drizzle(env.DB)
    .select()
    .from(projects)
    .where(eq(projects.id, parsed.data))
    .get();
  const role =
    project === undefined ? undefined : await roleIn(env, by, project);
  if (project === undefined || role === undefined) {
    throw projectErrors.create("project.not_found");
  }
  if (needed === "builder" && role !== "builder") {
    throw roleErrors.create("role.forbidden");
  }
  return { project, role };
};

/**
 * Why a write guarded by project `id`'s room (project-sql.ts) wrote
 * nothing, read now: `project.not_found` once it is gone,
 * `role.forbidden` once `by` no longer builds it, and `project.full`
 * otherwise.
 */
export const projectRefusal = async (
  env: Pick<Env, "DB">,
  id: string,
  by: string
): Promise<Error> => {
  const row = await drizzle(env.DB).get<{ there: number; builds: number }>(
    sql`SELECT EXISTS (SELECT 1 FROM ${projects} WHERE ${projects.id} = ${id}) AS there,
      ${projectBuiltBySql(id, by)} AS builds`
  );
  if (row.there === 0) {
    return projectErrors.create("project.not_found");
  }
  if (row.builds === 0) {
    return roleErrors.create("role.forbidden");
  }
  return projectErrors.create("project.full");
};

/**
 * Refuses, as `projectRefusal` says, unless `guard` (a project's ID
 * while `by` builds it and it has room, project-sql.ts) reads a project
 * now: for a write elsewhere, such as an item's own Share dialog, before
 * it writes under the same guard.
 */
export const requireProjectRoom = async (
  env: Pick<Env, "DB">,
  id: string,
  by: string,
  guard: SQL
): Promise<void> => {
  const row = await drizzle(env.DB).get<{ id: string | null } | undefined>(
    sql`SELECT ${guard} AS id`
  );
  if (row?.id === null || row?.id === undefined) {
    throw await projectRefusal(env, id, by);
  }
};

/**
 * That `by` is in the project in `projects.id`'s row, as a condition on
 * `projects`: every project for an admin (undefined). With `builds`, only
 * those they build: their own, and those they are in as a builder while
 * their organization role builds.
 */
export const projectsFoundBy = (
  by: Person,
  builds = false
): SQL | undefined => {
  if (isAdmin(by.role)) {
    return undefined;
  }
  // Only someone whose organization role builds builds a project, its
  // owner included (`rolesIn`).
  if (builds && !canBuild(by.role)) {
    return sql`0`;
  }
  const teams = by.teams.map(({ id }) => id);
  const theirs = or(
    and(
      eq(projectMembers.memberType, "person"),
      eq(projectMembers.memberId, by.userId)
    ),
    teams.length === 0
      ? undefined
      : and(
          eq(projectMembers.memberType, "team"),
          inList(projectMembers.memberId, teams)
        )
  );
  const role = builds ? sql`AND ${projectMembers.role} = 'builder'` : sql``;
  return or(
    eq(projects.ownerId, by.userId),
    sql`EXISTS (SELECT 1 FROM ${projectMembers} WHERE ${projectMembers.projectId} = ${projects.id} AND ${theirs} ${role})`
  );
};

/**
 * The projects `by` builds, by ID and name: what they may share an App or
 * workflow with.
 */
export const buildsProjectsOf = async (
  env: Pick<Env, "DB">,
  by: Person
): Promise<{ id: string; name: string }[]> =>
  await drizzle(env.DB)
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(projectsFoundBy(by, true))
    .orderBy(asc(projects.name), asc(projects.id));

/**
 * The names of those of projects `ids` that `by` is in: a project's name
 * is its members' alone, so a sharing list shows anyone else its row
 * unnamed.
 */
export const namedProjectsFor = async (
  env: Pick<Env, "DB">,
  by: Person,
  ids: readonly string[]
): Promise<Map<string, string>> => {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await drizzle(env.DB)
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(inList(projects.id, ids), projectsFoundBy(by)));
  return new Map(rows.map(({ id, name }) => [id, name]));
};

/**
 * The people in project `id` now, by user ID: its owner, the people in it,
 * and everyone in a team in it, each once, while they are members of the
 * organization. Whom a share with the project reaches.
 */
export const peopleInProject = async (
  env: Pick<Env, "DB">,
  id: string
): Promise<string[]> => {
  const rows = await drizzle(env.DB).all<{ userId: string }>(
    sql`SELECT person AS userId FROM (
      SELECT ${projects.ownerId} AS person FROM ${projects} WHERE ${projects.id} = ${id}
      UNION SELECT ${projectMembers.memberId} FROM ${projectMembers}
        WHERE ${projectMembers.projectId} = ${id} AND ${projectMembers.memberType} = 'person'
      UNION SELECT ${teamMembers.userId} FROM ${teamMembers}
        JOIN ${projectMembers} ON ${projectMembers.memberType} = 'team'
          AND ${projectMembers.memberId} = ${teamMembers.teamId}
        WHERE ${projectMembers.projectId} = ${id}
    ) WHERE ${activeMember(sql.raw("person"))}`
  );
  return rows.map(({ userId }) => userId).toSorted();
};
