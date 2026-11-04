import type {
  DependencySubject,
  NamedDependencySubject,
} from "@grasp-os/shared/dependencies";
import { roleErrors } from "@grasp-os/shared/roles";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { appFor, editableApp } from "../apps.ts";
import { activeMember } from "../auth/auth.ts";
import type { Acting } from "../auth/identity.ts";
import {
  appMembers,
  apps,
  teamMembers,
  workflowResourceMembers,
  workflowResources,
} from "../db/core/schema.ts";
import { viaProjectSql } from "../project-sql.ts";
import { requireWorkflowRole } from "../workflow-resources.ts";

// Who may ask for a subject's packages, or read them as one of its
// builders: an App's builders (`appFor`), or a workflow's
// (`requireWorkflowRole`). Apart from subjects.ts, which the workflow
// registry uses when it deletes a workflow.

/**
 * `subject`, for one of its builders, with its name: `app.not_found` or
 * `workflow.resource_unavailable` for anyone with no role in it, and
 * `role.forbidden` for one who only uses it. With `change`, for asking,
 * resolving or building its packages, an archived App refuses
 * (`app.archived`, app-status.ts).
 */
export const builtSubject = async (
  env: Env,
  by: Acting,
  subject: DependencySubject,
  change = false
): Promise<NamedDependencySubject> => {
  if (subject.type === "app") {
    const { id, name } = change
      ? await editableApp(env, by, subject.id)
      : await appFor(env, by, subject.id, "builder");
    return { type: "app", id, name };
  }
  // Grasp staff neither ask for, build nor read a workflow's packages,
  // whatever role their session carries.
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
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
 * That `person` builds `subject` when the statement runs, as SQL: as
 * `builtSubject` decides it (app-access.ts, workflow-resources.ts), for the
 * write that acts on it to check again in its own statement, so someone
 * unshared, taken off a team or demoted while a decision was under way
 * (its registry and OSV.dev reads take seconds) changes nothing. An admin
 * of the organization; or someone whose role there builds who owns it, or
 * it is shared with as a builder: as a person, through a team or through
 * a project they are in then. A removed App or deleted workflow is
 * nobody's.
 */
export const buildsSubjectSql = (
  person: string,
  subject: DependencySubject
): SQL => {
  const shared =
    subject.type === "app"
      ? sql`EXISTS (SELECT 1 FROM ${appMembers}
          WHERE ${appMembers.appId} = ${subject.id} AND ${appMembers.role} = 'builder'
            AND ((${appMembers.memberType} = 'person' AND ${appMembers.memberId} = ${person})
              OR (${appMembers.memberType} = 'team' AND ${appMembers.memberId} IN (
                SELECT ${teamMembers.teamId} FROM ${teamMembers} WHERE ${teamMembers.userId} = ${person}))
              OR ${viaProjectSql(appMembers.memberType, appMembers.memberId, person)}))`
      : sql`EXISTS (SELECT 1 FROM ${workflowResourceMembers}
          WHERE ${workflowResourceMembers.workflowResourceId} = ${subject.id} AND ${workflowResourceMembers.role} = 'builder'
            AND ((${workflowResourceMembers.memberType} = 'person' AND ${workflowResourceMembers.memberId} = ${person})
              OR (${workflowResourceMembers.memberType} = 'team' AND ${workflowResourceMembers.memberId} IN (
                SELECT ${teamMembers.teamId} FROM ${teamMembers} WHERE ${teamMembers.userId} = ${person}))
              OR ${viaProjectSql(workflowResourceMembers.memberType, workflowResourceMembers.memberId, person)}))`;
  const there =
    subject.type === "app"
      ? sql`EXISTS (SELECT 1 FROM ${apps} WHERE ${apps.id} = ${subject.id} AND ${apps.removedAt} IS NULL)`
      : sql`EXISTS (SELECT 1 FROM ${workflowResources} WHERE ${workflowResources.id} = ${subject.id} AND ${workflowResources.deletedAt} IS NULL)`;
  const owns =
    subject.type === "app"
      ? sql`EXISTS (SELECT 1 FROM ${apps} WHERE ${apps.id} = ${subject.id} AND ${apps.ownerId} = ${person})`
      : sql`EXISTS (SELECT 1 FROM ${workflowResources} WHERE ${workflowResources.id} = ${subject.id} AND ${workflowResources.ownerId} = ${person})`;
  return sql`(${there} AND (${activeMember(person, ["admin"])}
    OR (${activeMember(person, ["admin", "builder"])} AND (${owns} OR ${shared}))))`;
};
