import {
  declaredWorkflows,
  schemaFromDescriptor,
  workflowFingerprint,
} from "@grasp-os/sdk/host";
import type { BoundWorkflow, WorkflowPin } from "@grasp-os/sdk/host";
import { versionErrors } from "@grasp-os/shared/app-releases";
import { delegateActorOf } from "@grasp-os/shared/audit";
import { appIdSchema, workflowResourceIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import {
  categoryOf,
  isRetryableCode,
  operationErrors,
} from "@grasp-os/shared/operations";
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
  workflowResourceRuns,
  workflowStartReceipts,
} from "./db/core/schema.ts";
import { requireNotRevoked } from "./release-runner.ts";
import { coreStartKey } from "./workflow-start-intents.ts";
import { appStartHoldsSql } from "./workflow-starts.ts";
import { resultOf, runOf, stopResourceRun } from "./workflows/resource-runs.ts";
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
//   value under one revision, which moves only forward with the run's own
//   lifecycle (`revisionOf`); a control's receipt carries the same
//   revisions, so the screen knows which snapshot settles it.
// - What a run returned reaching anyone else: only the run's person sees
//   its snapshot, through the App that started it, under the run's
//   retention (`resultOf`).
// - Controls this platform can't serialize yet: an independent run has no
//   paused state of its own (the engine's pause shows as running), so
//   pause and resume are refused (`workflow.control_refused`) and offered
//   to nobody; cancel is the one control.

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

/**
 * Run `row`'s revision: 1 while queued, 2 running, 3 running with a
 * cancel asked, 4 ended. A run's lifecycle only moves forward, so neither
 * does this, and everything a snapshot holds is decided by where the run
 * is in it (and by who may control it, which the gate, not the revision,
 * keeps current).
 */
const revisionOf = (row: RunRow, cancelling: boolean): number => {
  if (isEnded(row.status)) {
    return 4;
  }
  if (row.status === "starting") {
    return 1;
  }
  return cancelling ? 3 : 2;
};

/** The revision of a run whose cancel was applied: its end's. */
const endedRevision = 4;

/** A run's status, as a screen sees it. */
const statusOf = {
  starting: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

/** The most of a failure's message a snapshot carries. */
const messageMax = 2000;

/**
 * The fingerprint of the contract the App version that started a run
 * declared for `alias`: the reference's own when it is the current
 * version's, so the screen tells a run of another contract apart.
 */
const startedFingerprint = async (
  env: Env,
  asking: Asking,
  resolved: Resolved,
  originAppVersion: number | null
): Promise<string> => {
  if (originAppVersion === null) {
    throw workflowResourceErrors.create("workflow.run_unavailable");
  }
  if (originAppVersion === asking.version) {
    return resolved.fingerprint;
  }
  const started = await declaredIn(
    await loadRelease(env, asking.app, originAppVersion),
    resolved.alias
  );
  if (started === undefined) {
    throw workflowResourceErrors.create("workflow.run_unavailable");
  }
  return started.fingerprint;
};

/** What a failed run's snapshot says of why. */
const failureOf = (
  error: { code: string | null; message: string } | undefined
) => {
  const code = error?.code ?? "workflow.step_failed";
  return {
    code,
    message: (error?.message ?? "The run failed.").slice(0, messageMax),
    category: categoryOf(code),
    retryable: isRetryableCode(code),
    requestId: null,
  };
};

/** Run `runId`'s snapshot for the asking person, and its revision. */
const runSnapshot = async (
  env: Env,
  asking: Asking,
  resolved: Resolved,
  runId: string
): Promise<{ value: Json; revision: number }> => {
  const pin = pinOf(resolved);
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
  const result = ended ? await resultOf(env, row) : {};
  const output =
    row.status === "completed" ? z.json().safeParse(result.output) : undefined;
  if (
    output !== undefined &&
    (result.output === undefined || !output.success)
  ) {
    // The contract has a completed run's output, always: past its
    // retention, there is none to show.
    throw workflowResourceErrors.create("workflow.run_details_removed");
  }
  const value: Json = {
    runId: row.id,
    workflowId: row.workflowResourceId,
    workflowVersion: row.version,
    manifestHash: row.manifestHash,
    fingerprint: await startedFingerprint(
      env,
      asking,
      resolved,
      originAppVersion
    ),
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
    ...(output?.success === true ? { output: output.data } : {}),
    ...(row.status === "failed" ? { error: failureOf(result.error) } : {}),
  };
  return { value, revision: revisionOf(row, cancelling) };
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

/** The receipt of `id`, as `controlled` answers it. */
const receiptOf = async (env: Env, id: string) =>
  await drizzle(env.DB)
    .select()
    .from(workflowResourceRunControls)
    .where(eq(workflowResourceRunControls.id, id))
    .get();

/**
 * The control `command` asks of a run, admitted: its receipt. Only a
 * cancel; pause and resume can't be serialized with it for an independent
 * run yet (see the header).
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
  const db = drizzle(env.DB);
  const where = and(
    eq(workflowResourceRunControls.runId, row.id),
    eq(workflowResourceRunControls.principalId, asking.by.userId),
    eq(workflowResourceRunControls.key, command.idempotencyKey)
  );
  let receipt = await db
    .select()
    .from(workflowResourceRunControls)
    .where(where)
    .get();
  if (receipt === undefined) {
    if (isEnded(row.status)) {
      // Nothing to stop: a cancelled run's cancel is done; any other end
      // can't be undone.
      if (row.status !== "cancelled") {
        throw workflowErrors.create("workflow.control_refused");
      }
      return { kind: "cancel", state: "applied", revision: endedRevision };
    }
    const id = crypto.randomUUID();
    // Written only while the person may still start the workflow through
    // the binding, read in this statement; the same key's twin, sent at
    // once, writes nothing.
    await db.run(sql`INSERT INTO ${workflowResourceRunControls}
      (id, run_id, app_id, principal_id, key, kind, state, created_at)
      SELECT ${id}, ${row.id}, ${asking.app}, ${asking.by.userId},
        ${command.idempotencyKey}, 'cancel', 'admitted', ${Date.now()}
      WHERE ${mayStartSql(asking, resolved.alias, pin)}
      ON CONFLICT (run_id, principal_id, key) DO NOTHING`);
    receipt = await db
      .select()
      .from(workflowResourceRunControls)
      .where(where)
      .get();
    if (receipt === undefined) {
      throw workflowResourceErrors.create("workflow.start_denied");
    }
    if (receipt.id === id) {
      await tellQueryFollowers(env, row.id);
    }
  }
  if (receipt.state === "admitted") {
    const now = await runOf(env, row.id);
    if (now !== undefined && !isEnded(now.status)) {
      // Asked of the engine as often as it takes: stopping a run is
      // idempotent, and a cancel whose answer was lost is applied again.
      await stopResourceRun(env, delegateActorOf(authorityOf(asking)), now);
    }
    await db
      .update(workflowResourceRunControls)
      .set({ state: "applied", settledAt: new Date() })
      .where(
        and(
          eq(workflowResourceRunControls.id, receipt.id),
          eq(workflowResourceRunControls.state, "admitted")
        )
      );
    receipt = (await receiptOf(env, receipt.id)) ?? receipt;
  }
  return {
    kind: "cancel",
    state: receipt.state,
    revision: receipt.state === "applied" ? endedRevision : 3,
  };
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
