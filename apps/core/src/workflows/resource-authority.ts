import {
  appIdSchema,
  runIdSchema,
  triggerIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { Authority, WorkContext } from "@grasp-os/shared/permissions";
import {
  catalogBindingKinds,
  workflowBindingTargetSchema,
  workflowResourceErrors,
} from "@grasp-os/shared/workflow-resources";
import { eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  workflowResourceRuns,
  workflowStartReceipts,
} from "../db/core/schema.ts";
import { allowingPermissionSql } from "../permissions.ts";
import { workflowRoleSql } from "../workflow-roles.ts";

// The authority behind each named call of a run of an independent workflow
// (platform specification 13.2, 13.6): what its start froze names the
// target of each binding, never proof that the run may still call it. So
// every call is decided again, as it is made, on authority as it is now
// (the #545 security review's L1):
//
// - the person the run acts for still has a role in the workflow, and is
//   an active member (`workflowRoleSql`);
// - the workflow is live;
// - the approval its start froze for the alias is still active, for the
//   run's exact version;
// - the permission that approval names (a connector's or an operation's)
//   is still active and still the workflow's own;
// - for a start by code, the `start` grant that let it start still holds:
//   a trigger still live and enabled, with its own grant active; an App's
//   grant still active for the App version that started it, approved;
//   an agent's own grant still active. An agent's grant may be one of a
//   chat's own, and a receipt keeps no chat, so any active `start` grant
//   of the agent's on the workflow counts, as one that let it start did.
//
// All in one statement, read as the call is made (`requireCallAuthority`),
// so revoking any of them stops the next call of a run already running;
// the call is refused with `workflow.call_denied`, and its run fails with
// it, while the start that was admitted stands. An App's export called by
// a run asks it again before each stub call the App's code makes in that
// call (`requireRunCallAllowed`, app-bindings.ts).

/** A catalog binding as a start froze it: its declaration, approval and target. */
const catalogBindingSchema = z.strictObject({
  alias: z.string().min(1).max(64),
  kind: z.enum(catalogBindingKinds),
  resourceId: z.null(),
  resourceVersion: z.null(),
  contractId: z.string().min(1).max(256),
  fingerprint: z.string().min(1).max(128),
  approval: z.string().min(1).max(128),
  target: workflowBindingTargetSchema,
});

/** Another workflow as a start froze it: run by `run` tasks (GRA-277). */
const workflowBindingSchema = z.strictObject({
  alias: z.string().min(1).max(64),
  kind: z.literal("workflow"),
  resourceId: z.string().min(1).max(128),
  resourceVersion: z.int().min(1),
  contractId: z.string().min(1).max(256),
  fingerprint: z.string().min(1).max(128),
});

const frozenBindingsSchema = z.array(
  z.union([catalogBindingSchema, workflowBindingSchema])
);

/** A catalog binding of a run's start, its approval and target frozen. */
export type FrozenCatalogBinding = z.infer<typeof catalogBindingSchema>;

/** The catalog bindings a start froze (its receipt's `bindings`), by alias. */
export const frozenBindingsOf = (
  text: string
): ReadonlyMap<string, FrozenCatalogBinding> =>
  new Map(
    frozenBindingsSchema
      .parse(JSON.parse(text))
      .flatMap((binding) =>
        binding.kind === "workflow" ? [] : [[binding.alias, binding] as const]
      )
  );

/** What a call of a run needs to know of it, from its row and receipt. */
export interface CallingRun {
  readonly runId: string;
  readonly workflowId: string;
  readonly version: number;
  /** Whom it acts for: the person its start acted for. */
  readonly principal: string;
  /**
   * Who started it, and for an App the version of its code that did: a
   * start by code needs the grant that let it start still to hold.
   */
  readonly invoker: {
    readonly type: "person" | "app" | "agent" | "trigger";
    readonly id: string;
    readonly appVersion: number | null;
  };
  /** The catalog bindings its start froze, by alias. */
  readonly bindings: ReadonlyMap<string, FrozenCatalogBinding>;
}

/** Who a run's calls act as: the workflow, for its principal, as a run. */
export const runAuthority = (run: CallingRun): Authority => ({
  subject: {
    type: "workflow",
    workflowId: workflowResourceIdSchema.parse(run.workflowId),
  },
  onBehalfOf: run.principal,
  mode: "workflow",
});

/** Where a run's calls work: the run itself. */
export const runContext = (run: CallingRun): WorkContext => ({
  type: "workflowRun",
  workflowId: workflowResourceIdSchema.parse(run.workflowId),
  runId: runIdSchema.parse(run.runId),
});

/**
 * That a start by code of run `run` still stands, as SQL, as the header
 * says: a trigger's, an App's or an agent's grant to start the workflow
 * still holding. A person's start needs nothing more than their role.
 */
const invokerSql = (run: CallingRun): SQL => {
  const object = {
    type: "workflow",
    workflowId: workflowResourceIdSchema.parse(run.workflowId),
  } as const;
  const { invoker } = run;
  switch (invoker.type) {
    case "person": {
      return sql`1`;
    }
    case "trigger": {
      const trigger = triggerIdSchema.safeParse(invoker.id);
      if (!trigger.success) {
        return sql`0`;
      }
      return sql`(EXISTS (SELECT 1 FROM trigger_resources AS live
          WHERE live.id = ${trigger.data} AND live.deleted_at IS NULL
            AND live.enabled = 1)
        AND EXISTS (SELECT 1 FROM permissions WHERE ${allowingPermissionSql(
          { type: "trigger", triggerId: trigger.data },
          undefined,
          object,
          "start"
        )}))`;
    }
    case "app": {
      const app = appIdSchema.safeParse(invoker.id);
      if (!app.success || invoker.appVersion === null) {
        return sql`0`;
      }
      return sql`EXISTS (SELECT 1 FROM permissions WHERE ${allowingPermissionSql(
        { type: "app", appId: app.data },
        invoker.appVersion,
        object,
        "start"
      )})`;
    }
    case "agent": {
      return sql`EXISTS (SELECT 1 FROM permissions AS held
        WHERE held.subject_type = 'agent' AND held.subject_id = ${invoker.id}
          AND held.object_type = 'workflow' AND held.object_id = ${run.workflowId}
          AND held.status = 'active'
          AND EXISTS (SELECT 1 FROM json_each(held.actions) WHERE value = 'start'))`;
    }
    default: {
      return invoker.type satisfies never;
    }
  }
};

/**
 * Refuses a call of `run` through `binding`, `workflow.call_denied`, unless
 * the authority behind it holds now, as the header says: one statement,
 * read as the call is made.
 */
export const requireCallAuthority = async (
  env: Env,
  run: CallingRun,
  binding: FrozenCatalogBinding
): Promise<void> => {
  const { workflowId: id, version } = run;
  const permission =
    "permissionId" in binding.target ? binding.target.permissionId : null;
  const permissionHolds =
    permission === null
      ? sql`1`
      : sql`EXISTS (SELECT 1 FROM permissions AS held
          WHERE held.id = ${permission} AND held.status = 'active'
            AND held.subject_type = 'workflow' AND held.subject_id = ${id})`;
  const { holds } = await drizzle(env.DB).get<{ holds: number }>(
    sql`SELECT (${workflowRoleSql(run.principal, id)}
      AND EXISTS (SELECT 1 FROM workflow_resources AS live
        WHERE live.id = ${id} AND live.deleted_at IS NULL)
      AND EXISTS (SELECT 1 FROM workflow_binding_approvals AS approval
        WHERE approval.id = ${binding.approval}
          AND approval.workflow_resource_id = ${id}
          AND approval.reviewed_version = ${version}
          AND approval.alias = ${binding.alias}
          AND approval.status = 'active')
      AND ${permissionHolds}
      AND ${invokerSql(run)}) AS holds`
  );
  if (holds === 0) {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
};

/**
 * Run `runId` of workflow `workflowId` as its calls know it, from its row
 * and its start's receipt; `undefined` when there is no such run, or it
 * has ended. Every host of a run (resource-runs.ts) and every App call of
 * one builds it here.
 */
export const callingRunOf = async (
  env: Env,
  workflowId: string,
  runId: string
): Promise<CallingRun | undefined> => {
  const row = await drizzle(env.DB)
    .select({
      workflowId: workflowResourceRuns.workflowResourceId,
      version: workflowResourceRuns.version,
      principal: workflowResourceRuns.principalId,
      status: workflowResourceRuns.status,
      invokerType: workflowStartReceipts.invokerType,
      invokerId: workflowStartReceipts.invokerId,
      originAppVersion: workflowStartReceipts.originAppVersion,
      bindings: workflowStartReceipts.bindings,
    })
    .from(workflowResourceRuns)
    .innerJoin(
      workflowStartReceipts,
      eq(workflowStartReceipts.id, workflowResourceRuns.id)
    )
    .where(eq(workflowResourceRuns.id, runId))
    .get();
  if (
    row === undefined ||
    row.workflowId !== workflowId ||
    (row.status !== "starting" && row.status !== "running")
  ) {
    return undefined;
  }
  return {
    runId,
    workflowId: row.workflowId,
    version: row.version,
    principal: row.principal,
    invoker: {
      type: row.invokerType,
      id: row.invokerId,
      appVersion: row.originAppVersion,
    },
    bindings: frozenBindingsOf(row.bindings),
  };
};

/**
 * What an App's export, called by a run, asks again before each stub call
 * its code makes in that call (app-bindings.ts): that the run's call
 * through `alias` is still allowed (`requireCallAuthority`), the run still
 * going. `workflow.call_denied` otherwise.
 */
export const requireRunCallAllowed = async (
  env: Env,
  admitted: { workflow: string; run: string; alias: string }
): Promise<void> => {
  const run = await callingRunOf(env, admitted.workflow, admitted.run);
  const binding = run?.bindings.get(admitted.alias);
  if (run === undefined || binding === undefined) {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  await requireCallAuthority(env, run, binding);
};
