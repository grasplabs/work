import {
  declaredWorkflows,
  schemaFromDescriptor,
  workflowFingerprint,
} from "@grasp-os/sdk/host";
import type { BoundWorkflow, WorkflowPin } from "@grasp-os/sdk/host";
import { versionErrors } from "@grasp-os/shared/app-releases";
import { expectedMessageOf, isExpectedCode } from "@grasp-os/shared/errors";
import { appIdSchema, workflowResourceIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import {
  categoryOf,
  isRetryableCode,
  operationErrors,
} from "@grasp-os/shared/operations";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { loadRelease } from "./app-releases.ts";
import type { Release } from "./app-releases.ts";
import { startAppBinding } from "./app-workflow-bindings.ts";
import { appFor } from "./apps.ts";
import {
  workflowResourceRunControls,
  workflowResources,
  workflowResourceRuns,
  workflowStartReceipts,
} from "./db/core/schema.ts";
import { isUniqueViolation } from "./db/d1.ts";
import { appHost } from "./durable-objects.ts";
import { requireNotRevoked } from "./release-runner.ts";
import { coreStartKey } from "./workflow-start-intents.ts";
import { appStartHoldsSql } from "./workflow-starts.ts";
import {
  applyCancel,
  cancelRepairAfterMs,
  resultOf,
  runOf,
} from "./workflows/resource-runs.ts";
import type { RunRow } from "./workflows/resource-runs.ts";
import { tellQueryFollowers } from "./workflows/run-changes.ts";

// What an App's screen asks of the workflows its App binds, through the
// typed `useWorkflow` (spec 10.4; the SDK's client-workflow.ts speaks the
// other side): a start, a control of a run, and live snapshots of a run
// and of whether the person may start one. Requests travel as a screen's
// calls and live queries do (app-functions.ts routes them here), never an
// agent's or a preview's. Threat model on GRA-626, and how each is closed:
//
// - A run started twice: by a render, a remount, a reconnect or a lost
//   answer. Only a command starts one, under the client's key, and the
//   receipt is unique per App, person and key, so a request sent again
//   answers the run it started (`startAppBinding`). A watch starts and
//   controls nothing.
// - A reference made up, stale or of another contract: it must name the
//   App's current release, an alias the release declares, and exactly the
//   fingerprint the release's declaration gives (`version.mismatch`
//   otherwise), computed here from the sealed release, never taken from
//   the request. Only an alias the seal pinned to a workflow version has
//   anything to start or watch.
// - A rebind since the seal running a version the reference's contract
//   wasn't made for: a start requires, in its admitting statement, that the
//   App's active binding still names exactly the pinned version; a run is
//   seen only while it does.
// - Another person's run, or another App's: a run is seen only when its
//   start receipt says this App started it for the caller, and it acts for
//   them, of exactly the pinned version; anything else, one that doesn't
//   exist included, is `workflow.run_unavailable`. No App role, owner or
//   admin sees past that.
// - Controls by someone who may no longer use the App: what the screen is
//   told it may do, and what a control requires as its receipt is written,
//   is the rule an App's start is admitted on now (`appStartHoldsSql`:
//   their role in the App, the release not revoked, the App's `start`
//   grant) and the binding in force: read in the statement that writes the
//   receipt, so a revocation between the two lets nothing through.
// - Status and capability from different moments: a run's snapshot is one
//   value under one revision, which moves only forward, with the run's
//   lifecycle and with the policy generation of its workflow (`revisionOf`):
//   an App grant revoked or given again is a revision of its own, and its
//   screens read again as it changes (permissions.ts). A control's receipt
//   carries the same revisions, so the screen knows which snapshot settles
//   it.
// - What a run returned reaching anyone else: only the run's person sees
//   its snapshot, through the App that started it, under the run's
//   retention (`resultOf`). What it returned is projected by the output
//   the App version that started it declared, refused if it doesn't fit;
//   why it failed, only as a code the platform defines, in the platform's
//   own words (`failureOf`): the engine's message, or a code of the
//   workflow's own, can be made of what the run read through grants the
//   App doesn't hold. A restricted run's result goes only through an App
//   in restricted mode itself.
// - A portable host: an App token from any origin, with no build core
//   approved, starts, controls and follows no run yet (app-function-route.ts,
//   portable-live.ts), until that is decided on its own.
// - Controls this platform can't serialize yet: an independent run has no
//   paused state of its own (the engine's pause shows as running), so
//   pause and resume are refused (`workflow.control_refused`) and offered
//   to nobody; cancel is the one control, one receipt per run whatever key
//   asks for it, settled once (`superseded` when the run ended otherwise
//   first), and applied again by the repair when its stop failed
//   (resource-runs.ts, `repairResourceTerminations`).

/** A workflow reference, as the SDK sends it. */
const referenceSchema = z.strictObject({
  resourceId: z.string().min(1).max(128),
  resourceVersion: z.int().min(1),
  contractId: z.string().min(1).max(256),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  kind: z.literal("workflow"),
});

/** A command's key, as the SDK makes it: 16 random bytes in hex. */
const keySchema = z.string().regex(/^[0-9a-f]{32}$/u);

const runIdSchema = z.string().min(1).max(128);

/** What a screen asks of a workflow (see the header). */
const workflowRequestSchema = z.union([
  z.strictObject({
    workflow: referenceSchema,
    command: z.literal("start"),
    input: z.unknown(),
    idempotencyKey: keySchema,
  }),
  z.strictObject({
    workflow: referenceSchema,
    command: z.enum(["pause", "resume", "cancel"]),
    runId: runIdSchema,
    idempotencyKey: keySchema,
  }),
  z.strictObject({
    workflow: referenceSchema,
    watch: z.literal("run"),
    runId: runIdSchema,
  }),
  z.strictObject({
    workflow: referenceSchema,
    watch: z.literal("binding"),
  }),
]);

/** A screen's request of a workflow, read. */
export type WorkflowRequest = z.infer<typeof workflowRequestSchema>;

/** A command: a start or a control. */
export type WorkflowCommand = Extract<WorkflowRequest, { command: string }>;

/** A watch: of a run, or of the binding. */
export type WorkflowWatch = Extract<WorkflowRequest, { watch: string }>;

const encoder = new TextEncoder();

/** `request` parsed, if it is JSON text within a call's bound. */
const parsedRequest = (request: unknown): unknown => {
  if (
    typeof request !== "string" ||
    request.length > functionRequestMaxBytes ||
    encoder.encode(request).byteLength > functionRequestMaxBytes
  ) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(request);
    return parsed;
  } catch {
    return undefined;
  }
};

/**
 * Whether `request` (a call's or live query's text) is a request of a
 * workflow: an object naming one under `workflow`. Then it is read as one
 * (`readWorkflowRequest`), never as a call of the App's functions.
 */
export const isWorkflowRequest = (request: unknown): boolean => {
  const parsed = parsedRequest(request);
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Object.hasOwn(parsed, "workflow")
  );
};

/**
 * The workflow request `request` is, read exactly:
 * `contract.invalid_request` for anything else.
 */
export const readWorkflowRequest = (request: unknown): WorkflowRequest => {
  const parsed = workflowRequestSchema.safeParse(parsedRequest(request));
  if (!parsed.success) {
    throw operationErrors.create("contract.invalid_request");
  }
  return parsed.data;
};

/** Whether `request` watches a workflow's run or binding. */
export const watchesWorkflow = (request: unknown): boolean => {
  try {
    return "watch" in readWorkflowRequest(request);
  } catch {
    return false;
  }
};

const aliasPattern = /^workflows\.(?<alias>[A-Za-z][A-Za-z0-9_]{0,63})$/u;

/** Who asks, and through which App's current release. */
interface Asking {
  readonly by: Pick<Identity, "userId" | "role" | "teams">;
  readonly app: AppId;
  readonly version: number;
  readonly release: Release;
}

/** What a reference resolved to in the release. */
interface Resolved {
  readonly alias: string;
  readonly declared: BoundWorkflow;
  /** The workflow version the seal pinned the alias to, if any. */
  readonly pinned: WorkflowPin | undefined;
  readonly fingerprint: string;
}

/**
 * The App `app` as `by` may use it now, and its current release: none
 * for someone without a role in it, a version not sealed or revoked.
 */
const askingOf = async (
  env: Env,
  by: Asking["by"],
  app: unknown
): Promise<Asking> => {
  const found = await appFor(env, by, app, "user");
  if (found.currentVersion === null) {
    throw versionErrors.create("version.not_sealed");
  }
  const id = appIdSchema.parse(found.id);
  await requireNotRevoked(env, id, found.currentVersion);
  return {
    by,
    app: id,
    version: found.currentVersion,
    release: await loadRelease(env, id, found.currentVersion),
  };
};

/** The workflow `alias` declares in `release`, with its fingerprint. */
const declaredIn = async (
  release: Release,
  alias: string
): Promise<{ declared: BoundWorkflow; fingerprint: string } | undefined> => {
  const declared = declaredWorkflows(release.app, release.workflows).find(
    (workflow) => workflow.alias === alias
  );
  return declared === undefined
    ? undefined
    : { declared, fingerprint: await workflowFingerprint(declared) };
};

/**
 * What `reference` names in the asking App's release: a workflow it
 * declares, of exactly its release and contract (`version.mismatch`
 * otherwise).
 */
const resolve = async (
  asking: Asking,
  reference: WorkflowRequest["workflow"]
): Promise<Resolved> => {
  const alias = aliasPattern.exec(reference.contractId)?.groups?.alias;
  const found =
    alias === undefined ? undefined : await declaredIn(asking.release, alias);
  if (alias === undefined || found === undefined) {
    throw operationErrors.create("operation.not_found");
  }
  const { manifest } = asking.release;
  if (
    reference.resourceId !== manifest.resourceId ||
    reference.resourceVersion !== manifest.resourceVersion ||
    reference.fingerprint !== found.fingerprint
  ) {
    throw versionErrors.create("version.mismatch");
  }
  return { alias, ...found, pinned: found.declared.pinned };
};

/** The pin of `resolved`: refused when the seal pinned nothing. */
const pinOf = (resolved: Resolved): WorkflowPin => {
  if (resolved.pinned === undefined) {
    throw workflowResourceErrors.create("workflow.app_binding_unavailable");
  }
  return resolved.pinned;
};

/** That the App's active binding of `alias` names exactly `pin`, as SQL. */
const bindingPinnedSql = (app: AppId, alias: string, pin: WorkflowPin): SQL =>
  sql`EXISTS (SELECT 1 FROM app_workflow_bindings
    WHERE app_id = ${app} AND alias = ${alias} AND status = 'active'
      AND workflow_resource_id = ${pin.workflowId}
      AND workflow_resource_version = ${pin.version})`;

/**
 * That the asking person may start `pin` through the App's binding of
 * `alias` now, as SQL: an App's start's own rule, and the binding in force.
 */
const mayStartSql = (asking: Asking, alias: string, pin: WorkflowPin): SQL => {
  const workflow = workflowResourceIdSchema.safeParse(pin.workflowId);
  if (!workflow.success) {
    return sql`0`;
  }
  return sql`(${appStartHoldsSql(
    asking.app,
    asking.version,
    asking.by.userId,
    workflow.data
  )} AND ${bindingPinnedSql(asking.app, alias, pin)})`;
};

/** Whether `condition` holds now. */
const holds = async (env: Env, condition: SQL): Promise<boolean> => {
  const row = await drizzle(env.DB).get<{ holds: number }>(
    sql`SELECT ${condition} AS holds`
  );
  return row.holds === 1;
};

/** The App's authority for the asking person, at its current version. */
const authorityOf = (asking: Asking): Authority => ({
  subject: { type: "app", appId: asking.app },
  onBehalfOf: asking.by.userId,
  mode: "interactive",
  appVersion: asking.version,
});

/** A run the asking person sees, and the App version that started it. */
interface SeenRun {
  readonly row: RunRow;
  readonly originAppVersion: number | null;
}

/**
 * Run `runId`, if the asking App started it for the asking person and it
 * acts for them, of exactly `pin`, while the App's binding names `pin`:
 * `workflow.run_unavailable` for any other, one that doesn't exist alike.
 */
const seenRun = async (
  env: Env,
  asking: Asking,
  alias: string,
  pin: WorkflowPin,
  runId: string
): Promise<SeenRun> => {
  const found = await drizzle(env.DB)
    .select({
      id: workflowResourceRuns.id,
      originAppVersion: workflowStartReceipts.originAppVersion,
    })
    .from(workflowResourceRuns)
    .innerJoin(
      workflowStartReceipts,
      eq(workflowStartReceipts.id, workflowResourceRuns.id)
    )
    .where(
      and(
        eq(workflowResourceRuns.id, runId),
        eq(workflowStartReceipts.invokerType, "app"),
        eq(workflowStartReceipts.invokerId, asking.app),
        eq(workflowStartReceipts.principalId, asking.by.userId),
        eq(workflowResourceRuns.principalId, asking.by.userId),
        eq(workflowResourceRuns.workflowResourceId, pin.workflowId),
        eq(workflowResourceRuns.version, pin.version),
        bindingPinnedSql(asking.app, alias, pin)
      )
    )
    .get();
  const row = found === undefined ? undefined : await runOf(env, found.id);
  if (found === undefined || row === undefined) {
    throw workflowResourceErrors.create("workflow.run_unavailable");
  }
  return { row, originAppVersion: found.originAppVersion };
};

/** Whether a run in `status` has ended. */
const isEnded = (status: RunRow["status"]): boolean =>
  status !== "starting" && status !== "running";

/** Whether a cancel was asked of run `runId`. */
const cancelAsked = async (env: Env, runId: string): Promise<boolean> =>
  (await drizzle(env.DB)
    .select({ id: workflowResourceRunControls.id })
    .from(workflowResourceRunControls)
    .where(eq(workflowResourceRunControls.runId, runId))
    .get()) !== undefined;

/** Where a run is in its lifecycle, each later than the one before. */
const stages = { queued: 1, running: 2, cancelling: 3, ended: 4 } as const;

/** How many stages a policy generation holds (`revisionOf`). */
const stagesPerGeneration = 4;

/**
 * The revision of a run at `stage` of its lifecycle under its workflow's
 * policy generation `generation`, which every grant and revocation on the
 * workflow moves on (workflow-resources.ts, `nextGeneration`): the App's
 * `start` grant among them. Both only move forward, and a generation
 * moved on is later than any stage of the one before, so the revision
 * moves forward with either: what the person may do with the run (an App
 * grant revoked or given again) is a revision of its own, never a change
 * under the same one. Everything else a snapshot holds is the run's, or
 * the gate's to keep current (the person's role, the build's trust).
 */
const revisionOf = (
  generation: number,
  stage: (typeof stages)[keyof typeof stages]
): number => generation * stagesPerGeneration + stage;

/** Run `row`'s stage, a cancel asked of it or not. */
const stageOf = (
  row: RunRow,
  cancelling: boolean
): (typeof stages)[keyof typeof stages] => {
  if (isEnded(row.status)) {
    return stages.ended;
  }
  if (row.status === "starting") {
    return stages.queued;
  }
  return cancelling ? stages.cancelling : stages.running;
};

/** Workflow `id`'s policy generation now. */
const generationOf = async (env: Env, id: string): Promise<number> => {
  const row = await drizzle(env.DB)
    .select({ generation: workflowResources.policyGeneration })
    .from(workflowResources)
    .where(eq(workflowResources.id, id))
    .get();
  return row?.generation ?? 0;
};

/** A run's status, as a screen sees it. */
const statusOf = {
  starting: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

/**
 * The contract the App version that started a run declared for `alias`:
 * its fingerprint, so the screen tells a run of another contract apart,
 * and its output, which what the run returned is projected by.
 */
const startedContract = async (
  env: Env,
  asking: Asking,
  resolved: Resolved,
  originAppVersion: number | null
): Promise<{ fingerprint: string; output: unknown }> => {
  if (originAppVersion === null) {
    throw workflowResourceErrors.create("workflow.run_unavailable");
  }
  const started =
    originAppVersion === asking.version
      ? resolved
      : await declaredIn(
          await loadRelease(env, asking.app, originAppVersion),
          resolved.alias
        );
  if (started === undefined) {
    throw workflowResourceErrors.create("workflow.run_unavailable");
  }
  return { fingerprint: started.fingerprint, output: started.declared.output };
};

/** What a step's failure reads as when its own words can't be shown. */
const stepFailed = workflowErrors.create("workflow.step_failed");

/**
 * What a failed run's snapshot says of why: only a code the platform
 * defines, with the platform's own words for it, any other as
 * `workflow.step_failed`. Neither the engine's message nor a code merely
 * in a platform namespace leaves: either can be made of what the run
 * read through grants the App doesn't hold.
 */
export const failureOf = (
  error: { code: string | null; message?: string } | undefined
) => {
  const code =
    error?.code !== null &&
    error?.code !== undefined &&
    isExpectedCode(error.code)
      ? error.code
      : stepFailed.code;
  return {
    code,
    message: expectedMessageOf(code) ?? stepFailed.message,
    category: categoryOf(code),
    retryable: isRetryableCode(code),
    requestId: null,
  };
};

/**
 * What a completed run returned, projected by the output the App declared:
 * `contract.invalid_return` for anything else, `workflow.run_details_removed`
 * past its retention.
 */
const outputOf = (declared: unknown, output: unknown): Json => {
  if (output === undefined) {
    // The contract has a completed run's output, always: past its
    // retention, there is none to show.
    throw workflowResourceErrors.create("workflow.run_details_removed");
  }
  const checked = schemaFromDescriptor(JSON.stringify(declared))[
    "~standard"
  ].validate(output);
  if (checked instanceof Promise || checked.issues !== undefined) {
    throw operationErrors.create("contract.invalid_return");
  }
  const projected = z.json().safeParse(checked.value);
  if (!projected.success) {
    throw operationErrors.create("contract.invalid_return");
  }
  return projected.data;
};

/** Run `runId`'s snapshot for the asking person, and its revision. */
const runSnapshot = async (
  env: Env,
  asking: Asking,
  resolved: Resolved,
  runId: string
): Promise<{ value: Json; revision: number }> => {
  const pin = pinOf(resolved);
  // Read first, before anything the snapshot says: a grant or revocation
  // landing after this moves the generation on, so the snapshot read
  // under the one before it is never numbered as one of the newer's, and
  // the read again it causes is a revision of its own.
  const generation = await generationOf(env, pin.workflowId);
  const { row, originAppVersion } = await seenRun(
    env,
    asking,
    resolved.alias,
    pin,
    runId
  );
  const ended = isEnded(row.status);
  const cancelling = !ended && (await cancelAsked(env, row.id));
  const mayStart = await holds(env, mayStartSql(asking, resolved.alias, pin));
  const status = statusOf[row.status];
  const contract = await startedContract(
    env,
    asking,
    resolved,
    originAppVersion
  );
  const returned = row.status === "completed" || row.status === "failed";
  if (
    returned &&
    row.restricted &&
    !(await appHost(env, asking.app).isRestricted())
  ) {
    // What a restricted run returned, or why it failed, only to an App in
    // restricted mode itself: never out through one that isn't.
    throw permissionErrors.create("permission.restricted");
  }
  const result = returned ? await resultOf(env, row) : {};
  const output =
    row.status === "completed"
      ? outputOf(contract.output, result.output)
      : undefined;
  const value: Json = {
    runId: row.id,
    workflowId: row.workflowResourceId,
    workflowVersion: row.version,
    manifestHash: row.manifestHash,
    fingerprint: contract.fingerprint,
    status,
    startedAt: status === "queued" ? null : row.createdAt.getTime(),
    finishedAt: row.endedAt === null ? null : row.endedAt.getTime(),
    waits: [],
    control: {
      canPause: false,
      canResume: false,
      canCancel: !ended && !cancelling && mayStart,
      pendingControl: cancelling ? { kind: "cancel", stage: "applying" } : null,
    },
    ...(output === undefined ? {} : { output }),
    ...(row.status === "failed" ? { error: failureOf(result.error) } : {}),
  };
  return {
    value,
    revision: revisionOf(generation, stageOf(row, cancelling)),
  };
};

/** The start `command` asks for, admitted: its run's handle. */
const started = async (
  env: Env,
  asking: Asking,
  resolved: Resolved,
  command: Extract<WorkflowCommand, { command: "start" }>
): Promise<Json> => {
  const pin = pinOf(resolved);
  const checked = schemaFromDescriptor(JSON.stringify(resolved.declared.input))[
    "~standard"
  ].validate(command.input);
  if (checked instanceof Promise || checked.issues !== undefined) {
    throw operationErrors.create("contract.invalid_args");
  }
  const start = await startAppBinding(
    env,
    authorityOf(asking),
    resolved.alias,
    {
      input: checked.value,
      key: coreStartKey("screen", command.idempotencyKey),
    },
    undefined,
    // The binding still names the version the reference was made for.
    bindingPinnedSql(asking.app, resolved.alias, pin)
  );
  return {
    runId: start.id,
    workflowId: start.workflowId,
    workflowVersion: start.version,
    manifestHash: start.manifestHash,
  };
};

/** Run `runId`'s cancel receipt, if one was asked for. */
const cancelOf = async (env: Env, runId: string) =>
  await drizzle(env.DB)
    .select()
    .from(workflowResourceRunControls)
    .where(
      and(
        eq(workflowResourceRunControls.runId, runId),
        eq(workflowResourceRunControls.kind, "cancel")
      )
    )
    .get();

/**
 * A cancel receipt of a run of workflow `workflowId`, as a screen is
 * answered it: admitted, under the run's cancelling revision; settled,
 * its end's.
 */
const receiptAnswer = async (
  env: Env,
  workflowId: string,
  state: "admitted" | "applied" | "superseded"
): Promise<Json> => ({
  kind: "cancel",
  state,
  revision: revisionOf(
    await generationOf(env, workflowId),
    state === "admitted" ? stages.cancelling : stages.ended
  ),
});

/**
 * The control `command` asks of a run, admitted: its receipt. Only a
 * cancel, one per run whatever key asks for it; pause and resume can't be
 * serialized with it for an independent run yet (see the header).
 */
const controlled = async (
  env: Env,
  asking: Asking,
  resolved: Resolved,
  command: Extract<WorkflowCommand, { command: "pause" | "resume" | "cancel" }>
): Promise<Json> => {
  const pin = pinOf(resolved);
  const { row } = await seenRun(
    env,
    asking,
    resolved.alias,
    pin,
    command.runId
  );
  if (command.command !== "cancel") {
    throw workflowErrors.create("workflow.control_refused");
  }
  let receipt = await cancelOf(env, row.id);
  if (receipt === undefined) {
    if (isEnded(row.status)) {
      // Nothing to stop: a cancelled run's cancel is done; any other end
      // can't be undone.
      if (row.status !== "cancelled") {
        throw workflowErrors.create("workflow.control_refused");
      }
      return await receiptAnswer(env, row.workflowResourceId, "applied");
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    try {
      // Written only while the person may still start the workflow
      // through the binding, read in this statement; a twin sent at
      // once, under whatever key, writes nothing.
      await drizzle(env.DB).run(sql`INSERT INTO ${workflowResourceRunControls}
        (id, run_id, app_id, principal_id, key, kind, state, created_at,
          next_at)
        SELECT ${id}, ${row.id}, ${asking.app}, ${asking.by.userId},
          ${command.idempotencyKey}, 'cancel', 'admitted', ${now},
          ${now + cancelRepairAfterMs}
        WHERE ${mayStartSql(asking, resolved.alias, pin)}`);
    } catch (error) {
      // The twin's receipt, written first: answered below.
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
    receipt = await cancelOf(env, row.id);
    if (receipt === undefined) {
      throw workflowResourceErrors.create("workflow.start_denied");
    }
    if (receipt.id === id) {
      await tellQueryFollowers(env, row.id);
    }
  }
  if (receipt.state === "admitted") {
    try {
      await applyCancel(env, receipt, row.id);
      receipt = (await cancelOf(env, row.id)) ?? receipt;
    } catch (error) {
      // Admitted all the same, which is what the screen is answered: the
      // repair applies it again (resource-runs.ts, `repairAdmittedCancels`).
      log.error("workflow.resource_run_cancel_failed", {
        runId: row.id,
        ...errorFields(error),
      });
    }
  }
  return await receiptAnswer(env, row.workflowResourceId, receipt.state);
};

/**
 * Answers a screen's workflow command `command` for `by` through App
 * `app`: a start's run handle, or a control's receipt; a refusal throws.
 * The answer names the release it was decided under.
 */
export const answerWorkflowCommand = async (
  env: Env,
  by: Asking["by"],
  app: unknown,
  command: WorkflowCommand
): Promise<{ value: Json; manifestHash: string }> => {
  const asking = await askingOf(env, by, app);
  const resolved = await resolve(asking, command.workflow);
  const value =
    command.command === "start"
      ? await started(env, asking, resolved, command)
      : await controlled(env, asking, resolved, command);
  return { value, manifestHash: asking.release.manifestHash };
};

/**
 * Reads a screen's workflow watch `watch` for `by` through App `app`: a
 * run's snapshot and its revision, or whether they may start a run now
 * (`{ canRun }`, whose revisions the subscription numbers); a refusal
 * throws.
 */
export const readWorkflowWatch = async (
  env: Env,
  by: Asking["by"],
  app: unknown,
  watch: WorkflowWatch
): Promise<{ value: Json; revision?: number; manifestHash: string }> => {
  const asking = await askingOf(env, by, app);
  const resolved = await resolve(asking, watch.workflow);
  const { manifestHash } = asking.release;
  if (watch.watch === "run") {
    return {
      ...(await runSnapshot(env, asking, resolved, watch.runId)),
      manifestHash,
    };
  }
  const canRun =
    resolved.pinned !== undefined &&
    (await holds(env, mayStartSql(asking, resolved.alias, resolved.pinned)));
  return { value: { canRun }, manifestHash };
};
