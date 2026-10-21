import { actorOf } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Authority } from "@grasp-os/shared/permissions";
import {
  appWorkflowBindingSchema,
  workflowResourceErrors,
  workflowStartSchema,
} from "@grasp-os/shared/workflow-resources";
import type {
  AppWorkflowBinding,
  WorkflowStart,
} from "@grasp-os/shared/workflow-resources";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { appFor } from "./apps.ts";
import { auditedBatch, outboxed, outboxedIfChanged } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import {
  appWorkflowBindings,
  workflowResourceVersions,
} from "./db/core/schema.ts";
import { isUniqueViolation, notNullFailed } from "./db/d1.ts";
import { appHost } from "./durable-objects.ts";
import { requireNotStaff } from "./sharing.ts";
import { requireWorkflowRole } from "./workflow-resources.ts";
import { startWorkflow } from "./workflow-starts.ts";
import type { StartingAgent } from "./workflow-starts.ts";
import type { StartFiles } from "./workflows/start-files.ts";

// Apps binding independent workflows (platform specification 3, 13.1,
// 15.1): an App names an exact version of a workflow by an alias of its
// own, and its code starts that version through the alias. The App never
// owns the workflow nor gains its grants. Threat model, and how each is
// closed:
//
// - Grouping or binding as a grant: a binding pins a version and nothing
//   more. Starting through it still takes the App's own `start`
//   permission on the workflow, granted by an admin, from a version of the
//   App an admin approved (workflow-starts.ts).
// - Binding a version you can't use: only someone who builds the App and
//   has a role in the workflow binds it, to a version the workflow
//   published; anyone else is told the workflow doesn't exist.
// - "latest": a binding names a publication number; a new version of the
//   workflow changes no binding. Moving to it is a new binding, audited.
// - A binding removed under a start: the start's admitting statement
//   requires the binding still active, as it requires the grant.
// - Deleting a workflow an App relies on: an active binding whose App
//   holds `start` on it keeps it from being deleted (workflow-resources.ts).
//   One whose App can't start it pins nothing, and the workflow's builders
//   may remove any binding to it, so no builder of some App keeps a
//   workflow alive by binding it.
// - Grasp staff deciding what a client's App runs: they never bind or
//   remove a binding (`role.forbidden`).
//
// A binding is the App's configuration, set by its builders and an admin's
// grant, like a workflow's parameters: not part of the App's sealed
// release. An approved App version starts whatever version its alias
// binds when it starts, and rolling the App back keeps the binding. The
// admin's `start` grant covers every version of the workflow, so a
// rebinding widens nothing a grant didn't.

const bindingOf = (
  row: typeof appWorkflowBindings.$inferSelect
): AppWorkflowBinding => ({
  id: row.id,
  app: row.appId,
  alias: row.alias,
  workflowId: row.workflowResourceId,
  version: row.workflowResourceVersion,
  boundBy: row.boundBy,
  boundAt: row.boundAt.toISOString(),
});

const invalid = () =>
  workflowResourceErrors.create("workflow.app_binding_invalid");

/**
 * Tells App `app`'s screens following its workflows to read them again
 * (app.ts, `workflowPolicyChanged`): a binding changed what each watch may
 * show and what its person may start (screen-workflows.ts). Best effort:
 * the change stands if the App can't be reached, and its screens read
 * again at their runs' next change.
 */
const tellBindingChanged = async (env: Env, app: string): Promise<void> => {
  try {
    await appHost(env, appIdSchema.parse(app)).workflowPolicyChanged();
  } catch (error) {
    log.error("app.workflow_policy_tell_failed", {
      appId: app,
      ...errorFields(error),
    });
  }
};

/**
 * Binds version `input.version` of workflow `id` to App `input.app` under
 * `input.alias`, for `by`, who must build the App and have a role in the
 * workflow. Replaces the alias's earlier binding in the same batch.
 */
export const bindWorkflowToApp = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<AppWorkflowBinding> => {
  requireNotStaff(by);
  const { app, alias, version } = workflowResourceErrors.parse(
    "workflow.app_binding_invalid",
    appWorkflowBindingSchema,
    input
  );
  const found = await appFor(env, by, app, "builder");
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const published = await drizzle(env.DB)
    .select({ version: workflowResourceVersions.version })
    .from(workflowResourceVersions)
    .where(
      and(
        eq(workflowResourceVersions.workflowResourceId, workflow.id),
        eq(workflowResourceVersions.version, version)
      )
    )
    .get();
  if (published === undefined) {
    throw invalid();
  }
  const row: typeof appWorkflowBindings.$inferSelect = {
    id: crypto.randomUUID(),
    appId: found.id,
    alias,
    workflowResourceId: workflow.id,
    workflowResourceVersion: version,
    status: "active",
    boundBy: by.userId,
    boundAt: new Date(),
    removedBy: null,
    removedAt: null,
  };
  const db = drizzle(env.DB);
  try {
    await auditedBatch(env, db, [
      db
        .update(appWorkflowBindings)
        .set({
          status: "removed",
          removedBy: by.userId,
          removedAt: row.boundAt,
        })
        .where(
          and(
            eq(appWorkflowBindings.appId, found.id),
            eq(appWorkflowBindings.alias, alias),
            eq(appWorkflowBindings.status, "active")
          )
        ),
      db.insert(appWorkflowBindings).values({
        ...row,
        // Only while the workflow is live: otherwise NULL, which fails the
        // batch, so a deletion and this binding never both land.
        workflowResourceId: sql`(SELECT id FROM workflow_resources
          WHERE id = ${workflow.id} AND deleted_at IS NULL)`,
      }),
      outboxed(db, {
        actor: by.actor ?? actorOf(by),
        action: "workflow.app_binding.bound",
        target: { type: "app", id: found.id },
        detail: { binding: row.id, alias, workflowId: workflow.id, version },
      }),
    ]);
  } catch (error) {
    if (notNullFailed(error, "app_workflow_bindings.workflow_resource_id")) {
      throw workflowResourceErrors.create("workflow.resource_unavailable");
    }
    if (isUniqueViolation(error)) {
      throw workflowResourceErrors.create("workflow.binding_conflict");
    }
    throw error;
  }
  await tellBindingChanged(env, found.id);
  return bindingOf(row);
};

/**
 * Whether `by` may remove `row`: they build its App, or the workflow it
 * binds, whose deletion it may hold up.
 */
const mayRemove = async (
  env: Env,
  by: Acting,
  row: typeof appWorkflowBindings.$inferSelect
): Promise<boolean> => {
  for (const check of [
    async () => await appFor(env, by, row.appId, "builder"),
    async () =>
      await requireWorkflowRole(env, by, row.workflowResourceId, "builder"),
  ]) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- the second only if the first refuses
      await check();
      return true;
    } catch (error) {
      if (!isExpectedError(error)) {
        throw error;
      }
    }
  }
  return false;
};

/**
 * Removes App binding `binding`, for `by`, who must build its App or the
 * workflow it binds, and isn't Grasp staff; anyone else is told there is
 * no such binding.
 */
export const unbindWorkflowFromApp = async (
  env: Env,
  by: Acting,
  binding: unknown
): Promise<void> => {
  requireNotStaff(by);
  if (typeof binding !== "string") {
    throw workflowResourceErrors.create("workflow.app_binding_unavailable");
  }
  const row = await drizzle(env.DB)
    .select()
    .from(appWorkflowBindings)
    .where(
      and(
        eq(appWorkflowBindings.id, binding),
        eq(appWorkflowBindings.status, "active")
      )
    )
    .get();
  if (row === undefined) {
    throw workflowResourceErrors.create("workflow.app_binding_unavailable");
  }
  if (!(await mayRemove(env, by, row))) {
    throw workflowResourceErrors.create("workflow.app_binding_unavailable");
  }
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(appWorkflowBindings)
      .set({ status: "removed", removedBy: by.userId, removedAt: new Date() })
      .where(
        and(
          eq(appWorkflowBindings.id, row.id),
          eq(appWorkflowBindings.status, "active")
        )
      ),
    outboxedIfChanged(db, {
      actor: by.actor ?? actorOf(by),
      action: "workflow.app_binding.removed",
      target: { type: "app", id: row.appId },
      detail: {
        binding: row.id,
        alias: row.alias,
        workflowId: row.workflowResourceId,
        version: row.workflowResourceVersion,
      },
    }),
  ]);
  await tellBindingChanged(env, row.appId);
};

/**
 * Starts the workflow version App code's `authority` binds under `alias`,
 * with `request` (its input and idempotency key): through the App's own
 * `start` permission, acting for the person its call acts for, and only
 * while the binding is still active as the start is admitted. Resolved
 * here, as it stands now: a binding is the App's configuration, not part
 * of the App version running (see above).
 */
export const startAppBinding = async (
  env: Env,
  authority: Authority,
  alias: unknown,
  request: unknown,
  /** What else the start's audit event names (the agent that had it made). */
  noted?: Readonly<Record<string, string>>,
  /**
   * What else must hold as the start is admitted, as SQL (the permission
   * of the agent that had it made), read by the admitting statement.
   */
  requires: SQL = sql`1`,
  /** Asked just before the start is admitted: throws to start nothing. */
  beforeAdmit?: () => void,
  /** The agent whose call made it, whose chat's restricted mode it takes. */
  agent: StartingAgent | null = null,
  /** The App files it may hand its run: a screen's start's only (GRA-885). */
  files?: StartFiles
): Promise<WorkflowStart> => {
  if (authority.subject.type !== "app" || typeof alias !== "string") {
    throw workflowResourceErrors.create("workflow.app_binding_unavailable");
  }
  const { input, key } = workflowResourceErrors.parse(
    "workflow.start_invalid",
    workflowStartSchema.omit({ version: true }),
    request
  );
  const row = await drizzle(env.DB)
    .select()
    .from(appWorkflowBindings)
    .where(
      and(
        eq(appWorkflowBindings.appId, authority.subject.appId),
        eq(appWorkflowBindings.alias, alias),
        eq(appWorkflowBindings.status, "active")
      )
    )
    .get();
  if (row === undefined) {
    throw workflowResourceErrors.create("workflow.app_binding_unavailable");
  }
  return await startWorkflow(
    env,
    { type: "app", authority, agent },
    row.workflowResourceId,
    { version: row.workflowResourceVersion, input, key },
    sql`EXISTS (SELECT 1 FROM app_workflow_bindings
      WHERE id = ${row.id} AND status = 'active') AND ${requires}`,
    noted,
    beforeAdmit,
    files
  );
};
