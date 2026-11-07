import {
  dependencyErrors,
  dependencySubjectRefSchema,
  subjectOfRef,
} from "@grasp-os/shared/dependencies";
import type {
  DependencySubject,
  NamedDependencySubject,
} from "@grasp-os/shared/dependencies";
import { roleErrors } from "@grasp-os/shared/roles";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { appFor, editableApp } from "../apps.ts";
import type { Acting } from "../auth/identity.ts";
import {
  appMembers,
  apps,
  dependencyRequests,
  members,
  teamMembers,
  workflowResourceMembers,
  workflowResources,
} from "../db/core/schema.ts";
import { requireWorkflowRole } from "../workflow-resources.ts";

// Whose packages a request is (an App, or an independent workflow), and
// who builds it: who may ask for its packages, decide them, and is told
// when the clock finds something wrong with them.

/** That a row of `dependency_requests` is `subject`'s, as SQL. */
export const ofSubject = (subject: DependencySubject): SQL =>
  and(
    eq(dependencyRequests.subjectType, subject.type),
    eq(dependencyRequests.subjectId, subject.id)
  ) ?? sql`0`;

/** What the audit log names a subject as, as every other event of either does. */
export const auditTargetOf = (
  subject: DependencySubject
): { type: "app" | "workflow_resource"; id: string } => ({
  type: subject.type === "app" ? "app" : "workflow_resource",
  id: subject.id,
});

/** The subject a caller names (`{ app }` or `{ workflow }`), or `dependency.invalid`. */
export const subjectOfInput = (input: unknown): DependencySubject =>
  subjectOfRef(
    dependencyErrors.parse(
      "dependency.invalid",
      dependencySubjectRefSchema,
      input
    )
  );

/**
 * `subject`, for one of its builders, with its name: `app.not_found` or
 * `workflow.resource_unavailable` for anyone with no role in it, and
 * `role.forbidden` for one who only uses it or is Grasp staff. With
 * `change`, for asking for its packages, an archived App refuses
 * (`app.archived`).
 */
export const builtSubject = async (
  env: Env,
  by: Acting,
  subject: DependencySubject,
  change = false
): Promise<NamedDependencySubject> => {
  // Grasp staff neither ask for nor decide what a client's Apps and
  // workflows may use, whatever role their session carries.
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
  }
  if (subject.type === "app") {
    const { id, name } = change
      ? await editableApp(env, by, subject.id)
      : await appFor(env, by, subject.id, "builder");
    return { type: "app", id, name };
  }
  const { id, name } = await requireWorkflowRole(
    env,
    by,
    subject.id,
    "builder"
  );
  return { type: "workflow", id, name };
};

/**
 * The members who build `subject` now, whom the clock tells what it found
 * of its packages: its owner and whom it is shared with as a builder, as
 * a person or through a team, whose role in the organization builds.
 */
export const buildersOf = async (
  env: Env,
  subject: DependencySubject
): Promise<string[]> => {
  const shared =
    subject.type === "app"
      ? sql`SELECT ${apps.ownerId} AS person FROM ${apps} WHERE ${apps.id} = ${subject.id} AND ${apps.removedAt} IS NULL
      UNION SELECT ${appMembers.memberId} FROM ${appMembers} WHERE ${appMembers.appId} = ${subject.id} AND ${appMembers.role} = 'builder' AND ${appMembers.memberType} = 'person'
      UNION SELECT ${teamMembers.userId} FROM ${appMembers} INNER JOIN ${teamMembers} ON ${teamMembers.teamId} = ${appMembers.memberId} WHERE ${appMembers.appId} = ${subject.id} AND ${appMembers.role} = 'builder' AND ${appMembers.memberType} = 'team'`
      : sql`SELECT ${workflowResources.ownerId} AS person FROM ${workflowResources} WHERE ${workflowResources.id} = ${subject.id} AND ${workflowResources.deletedAt} IS NULL
      UNION SELECT ${workflowResourceMembers.memberId} FROM ${workflowResourceMembers} WHERE ${workflowResourceMembers.workflowResourceId} = ${subject.id} AND ${workflowResourceMembers.role} = 'builder' AND ${workflowResourceMembers.memberType} = 'person'
      UNION SELECT ${teamMembers.userId} FROM ${workflowResourceMembers} INNER JOIN ${teamMembers} ON ${teamMembers.teamId} = ${workflowResourceMembers.memberId} WHERE ${workflowResourceMembers.workflowResourceId} = ${subject.id} AND ${workflowResourceMembers.role} = 'builder' AND ${workflowResourceMembers.memberType} = 'team'`;
  const builders = sql.raw("builders");
  const rows = await drizzle(env.DB).all<{ person: string }>(
    sql`WITH ${builders} AS (${shared})
      SELECT person FROM ${builders} WHERE EXISTS (SELECT 1 FROM ${members} WHERE ${members.userId} = ${builders}.person AND ${members.role} IN ('builder', 'admin'))`
  );
  return rows.map(({ person }) => person);
};

/** The name of `subject` now; a deleted workflow says so. */
export const subjectName = async (
  env: Env,
  subject: DependencySubject
): Promise<string> => {
  const db = drizzle(env.DB);
  if (subject.type === "app") {
    const row = await db
      .select({ name: apps.name })
      .from(apps)
      .where(eq(apps.id, subject.id))
      .get();
    return row?.name ?? "";
  }
  const row = await db
    .select({
      name: workflowResources.name,
      deletedAt: workflowResources.deletedAt,
    })
    .from(workflowResources)
    .where(eq(workflowResources.id, subject.id))
    .get();
  if (row === undefined) {
    return "";
  }
  return row.deletedAt === null ? row.name : `${row.name} (deleted)`;
};
