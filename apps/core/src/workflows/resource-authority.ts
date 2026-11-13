import {
  appIdSchema,
  runIdSchema,
  triggerIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
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
import { accountOf } from "./quotas.ts";

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
//   a trigger still live and enabled, still of the run's workflow (a run
//   keeps its version, whatever went live since), with its own grant
//   active; an App's
//   grant still active for the App version that started it, approved;
//   an agent's own grant still active. An agent's grant may be one of a
//   chat's own, and a receipt keeps no chat, so any active `start` grant
//   of the agent's on the workflow counts, as one that let it start did.
//
// All in one statement, read as the call is made (`requireCallAuthority`),
// so revoking any of them stops the next call of a run already running;
// the call is refused with `workflow.call_denied`, and its run fails with
// it, while the start that was admitted stands.

/** A catalog binding as a start froze it: its declaration, approval and target. */
const catalogBindingSchema = z.strictObject({
  alias: z.string().min(1).max(64),
  kind: z.enum(catalogBindingKinds),
  contractId: z.string().min(1).max(256),
  fingerprint: z.string().min(1).max(128),
  approval: z.string().min(1).max(128),
  target: workflowBindingTargetSchema,
});

/** A catalog binding of a run's start, its approval and target frozen. */
export type FrozenCatalogBinding = z.infer<typeof catalogBindingSchema>;

const frozenBindingsSchema = z.array(catalogBindingSchema);

/** The catalog bindings a start froze (its receipt's `bindings`), by alias. */
export const frozenBindingsOf = (
  text: string
): ReadonlyMap<string, FrozenCatalogBinding> =>
  new Map(
    frozenBindingsSchema
      .parse(JSON.parse(text))
      .map((binding) => [binding.alias, binding] as const)
  );

/** What a call of a run needs to know of it, from its row and receipt. */
export interface CallingRun {
  readonly runId: string;
  /** Its lineage's root, as its row pins it: the run itself for a root. */
  readonly rootRunId: string;
  /**
   * The run whose allowances it is charged to, as its row pins it
   * (quotas.ts, `accountOf`): its lineage's root, or its workflow's account
   * in the lineage a trigger started it in. What its attempts and its model
   * requests count against at the gateway, with every other run charged
   * there (resource-calls.ts, `callModel`).
   */
  readonly accountRunId: string;
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
  /**
   * Whether it runs in restricted mode, as its start decided and its row
   * pins (restricted.ts): what it sends an App restricts that App first.
   */
  readonly restricted: boolean;
  /**
   * For a test run of a draft at one revision (candidate-runs.ts): each
   * binding the draft declares, by alias, with the catalog contract it
   * was checked against and the answer the start gave it, if any. Every
   * call it makes is answered from these and goes nowhere (`makeCall`);
   * one through a binding with no answer fails
   * (`workflow.candidate_unfixtured`).
   */
  readonly candidate?: ReadonlyMap<string, CandidateBinding>;
  /**
   * Whether its row says it is paused: nothing of it runs then, the
   * engine's say, but what a person does for it (confirming a call it
   * holds) waits for its resume (pending-actions.ts).
   */
  readonly paused?: boolean;
  /**
   * For a run an App's test started (fixture-runs.ts): it calls nothing
   * real. Its host answers its model and store calls from its test
   * (fixture-calls.ts), and `makeCall` refuses every call of it.
   */
  readonly fixture?: true;
}

/** A binding of a test run's checkpoint, and the answer its start gave it. */
export interface CandidateBinding {
  readonly kind: string;
  readonly contractId: string;
  readonly fingerprint: string;
  /** What every call through it answers; none, and a call fails. */
  readonly answer: Json | undefined;
}

/** Who a run's calls act as: the workflow, for its principal, as a run. */
export const runAuthority = (
  run: Pick<CallingRun, "workflowId" | "principal">
): Authority => ({
  subject: {
    type: "workflow",
    workflowId: workflowResourceIdSchema.parse(run.workflowId),
  },
  onBehalfOf: run.principal,
  mode: "workflow",
});

/**
 * Where a run's calls work: the run itself; for a write that attaches
 * files, with the files use they come from (`filesFrom`, GRA-887).
 */
export const runContext = (
  run: Pick<CallingRun, "workflowId" | "runId">,
  filesFrom?: string
): WorkContext => ({
  type: "workflowRun",
  workflowId: workflowResourceIdSchema.parse(run.workflowId),
  runId: runIdSchema.parse(run.runId),
  ...(filesFrom === undefined ? {} : { filesFrom }),
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
      // Still live and enabled, and still of this run's workflow: a run
      // keeps the version it started on, whatever went live since.
      return sql`(EXISTS (SELECT 1 FROM trigger_resources AS live
          JOIN trigger_resource_versions AS aim
            ON aim.trigger_id = live.id AND aim.version = live.current_version
          WHERE live.id = ${trigger.data} AND live.deleted_at IS NULL
            AND live.enabled = 1
            AND aim.workflow_resource_id = ${run.workflowId})
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
      // A chat's grant holds only for the person who asked for it there
      // (permissions.ts, `holdsIn`): another person's never keeps this
      // run's start standing.
      return sql`EXISTS (SELECT 1 FROM permissions AS held
        WHERE held.subject_type = 'agent' AND held.subject_id = ${invoker.id}
          AND held.object_type = 'workflow' AND held.object_id = ${run.workflowId}
          AND held.status = 'active'
          AND (held.chat_id IS NULL OR held.requested_by = ${run.principal})
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
  const { workflowId: id } = run;
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
 * Refuses a call of `run` of function `fn` of App `app` (by the stable
 * ID the App's definition gives it), `workflow.call_denied`, unless the
 * authority behind it holds now, in one statement read as the call is
 * made: the person's role in the workflow, the workflow live, the start
 * by code still standing (as `requireCallAuthority` decides them), and
 * the workflow's own active grant to `call` exactly that function of
 * exactly that App (workflows/app-calls.ts). No approval of a version,
 * the workflow's or the App's: the grant is the approval (see that
 * module's header).
 */
export const requireAppCallAuthority = async (
  env: Env,
  run: CallingRun,
  app: string,
  fn: string
): Promise<void> => {
  const { workflowId: id } = run;
  const { holds } = await drizzle(env.DB).get<{ holds: number }>(
    sql`SELECT (${workflowRoleSql(run.principal, id)}
      AND EXISTS (SELECT 1 FROM workflow_resources AS live
        WHERE live.id = ${id} AND live.deleted_at IS NULL)
      AND EXISTS (SELECT 1 FROM permissions AS held
        WHERE held.subject_type = 'workflow' AND held.subject_id = ${id}
          AND held.object_type = 'app' AND held.object_id = ${app}
          AND held.resource = ${fn} AND held.status = 'active'
          AND held.chat_id IS NULL
          AND EXISTS (SELECT 1 FROM json_each(held.actions) WHERE value = 'call'))
      AND ${invokerSql(run)}) AS holds`
  );
  if (holds === 0) {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
};

/** Run `runId`'s row and its start's receipt, as a run's calls read them. */
const runRowOf = async (env: Env, runId: string) =>
  await drizzle(env.DB)
    .select({
      workflowId: workflowResourceRuns.workflowResourceId,
      version: workflowResourceRuns.version,
      principal: workflowResourceRuns.principalId,
      status: workflowResourceRuns.status,
      restricted: workflowResourceRuns.restricted,
      rootRunId: workflowResourceRuns.rootRunId,
      accountRunId: workflowResourceRuns.accountRunId,
      invokerType: workflowStartReceipts.invokerType,
      invokerId: workflowStartReceipts.invokerId,
      originAppVersion: workflowStartReceipts.originAppVersion,
      bindings: workflowStartReceipts.bindings,
      detailsRemovedAt: workflowStartReceipts.detailsRemovedAt,
    })
    .from(workflowResourceRuns)
    .innerJoin(
      workflowStartReceipts,
      eq(workflowStartReceipts.id, workflowResourceRuns.id)
    )
    .where(eq(workflowResourceRuns.id, runId))
    .get();

/** Run `runId` as its calls know it, from `row` (`runRowOf`). */
const callingRunFrom = (
  runId: string,
  row: NonNullable<Awaited<ReturnType<typeof runRowOf>>>
): CallingRun => ({
  runId,
  rootRunId: row.rootRunId ?? runId,
  accountRunId: accountOf({ id: runId, ...row }),
  workflowId: row.workflowId,
  version: row.version,
  principal: row.principal,
  invoker: {
    type: row.invokerType,
    id: row.invokerId,
    appVersion: row.originAppVersion,
  },
  bindings: frozenBindingsOf(row.bindings),
  restricted: row.restricted,
  paused: row.status === "paused",
});

/**
 * Run `runId` of workflow `workflowId` as its calls know it, from its row
 * and its start's receipt; `undefined` when there is no such run, or it
 * has ended. Every host of a run (resource-runs.ts) and every App call of
 * one builds it here. A paused run is one that hasn't ended: whether
 * anything of it runs is the engine's to say, which runs nothing of a
 * paused run, and its row follows the engine late. Read `paused` as
 * refusing, a run resumed would fail its next activation, and the calls
 * it makes, until its row heard of the resume.
 */
export const callingRunOf = async (
  env: Env,
  workflowId: string,
  runId: string
): Promise<CallingRun | undefined> => {
  const row = await runRowOf(env, runId);
  if (
    row === undefined ||
    row.workflowId !== workflowId ||
    (row.status !== "starting" &&
      row.status !== "running" &&
      row.status !== "paused")
  ) {
    return undefined;
  }
  return callingRunFrom(runId, row);
};

/**
 * Run `runId` with its frozen bindings, ended or not: the run a reply to
 * its mail goes to (inbound-email.ts), whose binding says what the reply
 * may be. `undefined` once its details are gone (retention.ts): its row
 * stays, but not what it was bound to.
 */
export const heldRunOf = async (
  env: Env,
  runId: string
): Promise<CallingRun | undefined> => {
  const row = await runRowOf(env, runId);
  return row === undefined || row.detailsRemovedAt !== null
    ? undefined
    : callingRunFrom(runId, row);
};
