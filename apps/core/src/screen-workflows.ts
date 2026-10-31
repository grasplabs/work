import {
  declaredWorkflows,
  eventFingerprint,
  schemaFromDescriptor,
  workflowFingerprint,
} from "@grasp-os/sdk/host";
import type { BoundWorkflow, WorkflowPin } from "@grasp-os/sdk/host";
import { versionErrors } from "@grasp-os/shared/app-releases";
import type { AuditEntry } from "@grasp-os/shared/audit";
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
import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { loadRelease } from "./app-releases.ts";
import type { Release } from "./app-releases.ts";
import { bindingPinnedSql, startAppBinding } from "./app-workflow-bindings.ts";
import { usableApp } from "./apps.ts";
import { auditedBatch, outboxed, outboxedWhere } from "./audit-outbox.ts";
import {
  workflowResourceRunControlKeys,
  workflowResourceRunControls,
  workflowResources,
  workflowResourceRuns,
  workflowStartReceipts,
} from "./db/core/schema.ts";
import { isUniqueViolation } from "./db/d1.ts";
import { appHost } from "./durable-objects.ts";
import { requireNotRevoked } from "./release-runner.ts";
import { screenStartFiles } from "./screen-start-files.ts";
import { coreStartKey } from "./workflow-start-intents.ts";
import { appSendHoldsSql, appStartHoldsSql } from "./workflow-starts.ts";
import { aiWaitsOf } from "./workflows/ai-waits.ts";
import { runEngine } from "./workflows/engine.ts";
import {
  applyCancel,
  applyResourceControl,
  cancelRepairAfterMs,
  resultOf,
  runEntry,
  runOf,
  unended,
} from "./workflows/resource-runs.ts";
import type { ResourceControlRow, RunRow } from "./workflows/resource-runs.ts";
import { tellQueryFollowers } from "./workflows/run-changes.ts";
import { admitRunEvent, unlessAccepted } from "./workflows/run-events.ts";
import type { AdmittedEvent } from "./workflows/run-events.ts";
import { runWaits } from "./workflows/run-waits.ts";

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
// - An event sent to a run by someone, or through something, that may not
//   send it (spec 10.4.6). A send names a run the screen sees (above), an
//   event the release declares for the workflow, of exactly the type and
//   fingerprint the release resolved (`version.mismatch` otherwise), and
//   data that the event's declared contract takes, extra fields refused.
//   It needs the App's own `send` grant on the workflow, which no `start`,
//   `read` or decision implies, held for the person now with their role in
//   the App and the binding in force; the run takes it only as its inbox
//   admits any event (workflows/run-events.ts): through an event binding
//   its start froze, its contract pinned, its authority read again, and
//   only while it hasn't ended (`workflow.run_ended`: a send starts no run).
//   An App in restricted mode sends only to a run restricted itself
//   (`permission.restricted`): its screen's data may carry what it read.
//   The grant is read just before the inbox takes the event, in another
//   store, so a revocation landing between the two lets that one send in;
//   the next is refused.
// - A sender forging provenance, or another sender's event. A send carries
//   only the event's reference, its data and the client's key: a request
//   with any other field (an envelope's source, ID, time or subject) is
//   refused whole (`contract.invalid_request`). The host mints the
//   envelope: its source from the App, release and person the request is
//   authenticated as (`sourceOf`), its ID from the run, binding, source
//   and key, its time as the run accepts it.
// - One person's screen filling a run's inbox for every other sender: each
//   App and person is one sender, whose events hold no more than their
//   share of the inbox (`senderOf`), refused before the send is answered
//   (`workflow.event_refused`), never accepted and dropped.
// - A send admitted twice, or lost: each `send` call is its own key, so two
//   calls are two events, however equal their data; a resend of one under
//   its key, its answer lost, is the same event, answered with the same ID
//   (the run's inbox keeps every key it took, consumed or not, for as long
//   as it keeps the event, and answers for it even once the run ended or
//   the grant it was sent on went), and a key reused for other data is
//   refused (`workflow.event_conflict`). A run restarted from an earlier
//   step forgets the events nothing had taken (@grasp-os/workerflow,
//   `forgetIn`), keys and all: a resend of one of those after the restart
//   is admitted again, as the event the restart forgot. A send
//   resumes no paused run (the event waits for the run's resume), and
//   answers no decision, which only `decide` does.
// - Controls that undo one another: a pause or resume delivered late
//   undoing a newer control, or one outliving a cancel. Each admitted
//   control takes the run's next control generation in the statement that
//   writes its receipt, and goes to the engine with it, which ignores one
//   older than the newest it took (engine.ts); a receipt settles from the
//   generation the engine says it took, never from a status alone
//   (resource-runs.ts, `settleResourceControls`). One pause or resume is
//   unresolved at a time: the same kind asked again, under any key, joins
//   it, its key kept with the receipt it joined, so a retry under it is
//   answered that receipt again, never decided anew to undo a control
//   admitted since (`workflow_resource_run_control_keys`); the other, or either while a cancel is asked, is a conflict
//   (`workflow.control_conflict`). A cancel has priority: one per run
//   whatever key asks for it, it takes the next generation, so a pause or
//   resume admitted before it can no longer reach the engine, and
//   terminate is final there. A
//   request the run is already past (pausing a paused run) is applied at
//   once, as the engine has it, not the row, which may lag behind it.
//   Every receipt is applied again by the repair while it stays admitted
//   (`repairResourceTerminations`), and settled once, by the run's end at
//   the latest.
// - Controls while the run rolls back: none is offered or admitted while
//   the engine says the run is rolling back (spec 10.7.3: during a
//   compensation nothing may be paused, resumed or cancelled from an App).

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

/** An event a send names, by the reference the SDK was generated with. */
const eventReferenceSchema = z.strictObject({
  alias: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
  type: z.string().min(1).max(256),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
});

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
    command: z.literal("send"),
    runId: runIdSchema,
    event: eventReferenceSchema,
    data: z.unknown(),
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

/** A command: a start, a control or a send. */
type WorkflowCommand = Extract<WorkflowRequest, { command: string }>;

/** A watch: of a run, or of the binding. */
type WorkflowWatch = Extract<WorkflowRequest, { watch: string }>;

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
export interface Resolved {
  readonly alias: string;
  readonly declared: BoundWorkflow;
  /** The workflow version the seal pinned the alias to, if any. */
  readonly pinned: WorkflowPin | undefined;
  readonly fingerprint: string;
}

/**
 * The App `app` as `by` may use it now, and its current release: none
 * for someone without a role in it, an archived App, a version not sealed
 * or revoked.
 */
const askingOf = async (
  env: Env,
  by: Asking["by"],
  app: unknown
): Promise<Asking> => {
  const found = await usableApp(env, by, app);
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
 * What `reference` names in `release`: a workflow it declares, of exactly
 * that release and contract (`version.mismatch` otherwise). For an App's
 * tests too, against the release under test (fixture-runs.ts).
 */
export const resolveIn = async (
  release: Release,
  reference: WorkflowRequest["workflow"]
): Promise<Resolved> => {
  const alias = aliasPattern.exec(reference.contractId)?.groups?.alias;
  const found =
    alias === undefined ? undefined : await declaredIn(release, alias);
  if (alias === undefined || found === undefined) {
    throw operationErrors.create("operation.not_found");
  }
  const { manifest } = release;
  if (
    reference.resourceId !== manifest.resourceId ||
    reference.resourceVersion !== manifest.resourceVersion ||
    reference.fingerprint !== found.fingerprint
  ) {
    throw versionErrors.create("version.mismatch");
  }
  return { alias, ...found, pinned: found.declared.pinned };
};

/**
 * What `reference` names in the asking App's release: a workflow it
 * declares, of exactly its release and contract (`version.mismatch`
 * otherwise).
 */
const resolve = async (
  asking: Asking,
  reference: WorkflowRequest["workflow"]
): Promise<Resolved> => await resolveIn(asking.release, reference);

/** The pin of `resolved`: refused when the seal pinned nothing. */
export const pinOf = (resolved: Resolved): WorkflowPin => {
  if (resolved.pinned === undefined) {
    throw workflowResourceErrors.create("workflow.app_binding_unavailable");
  }
  return resolved.pinned;
};

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

/**
 * That the asking person may send events to their runs of `pin` through
 * the App's binding of `alias` now, as SQL: the App's `send` grant, by
 * `mayStartSql`'s rule otherwise.
 */
const maySendSql = (asking: Asking, alias: string, pin: WorkflowPin): SQL => {
  const workflow = workflowResourceIdSchema.safeParse(pin.workflowId);
  if (!workflow.success) {
    return sql`0`;
  }
  return sql`(${appSendHoldsSql(
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
  !unended.includes(status);

/**
 * Run `row` as it is now, and the control a screen sees applying on it:
 * its cancel if one is asked, which has priority, otherwise the pause or
 * resume unresolved; none once it has ended. Read in one batch, so both
 * are of one moment, and so of the revision the row says.
 */
const runAndPending = async (
  env: Env,
  row: RunRow
): Promise<[RunRow, ResourceControlRow["kind"] | undefined]> => {
  const db = drizzle(env.DB);
  const [rows, admitted] = await db.batch([
    db
      .select()
      .from(workflowResourceRuns)
      .where(eq(workflowResourceRuns.id, row.id)),
    db
      .select({ kind: workflowResourceRunControls.kind })
      .from(workflowResourceRunControls)
      .where(
        and(
          eq(workflowResourceRunControls.runId, row.id),
          eq(workflowResourceRunControls.state, "admitted")
        )
      ),
  ]);
  const now = rows[0] ?? row;
  if (isEnded(now.status)) {
    return [now, undefined];
  }
  const kinds = admitted.map(({ kind }) => kind);
  return [
    now,
    kinds.includes("cancel")
      ? "cancel"
      : kinds.find((kind) => kind !== "cancel"),
  ];
};

/**
 * The revision of a run's snapshot: the run's own (`summary_revision`,
 * moved on by every write that changes what its snapshot shows, in that
 * write) and its workflow's policy generation, which every grant and
 * revocation on the workflow moves on (workflow-resources.ts,
 * `nextGeneration`): the App's `start` grant among them. Both only move
 * forward, so their sum does with either: what the person may do with the
 * run (an App grant revoked or given again) is a revision of its own,
 * never a change under the same one. Everything else a snapshot holds is
 * the gate's to keep current (the person's role, the build's trust). One
 * more, so the first is 1.
 */
const revisionOf = (generation: number, row: RunRow): number =>
  generation + row.summaryRevision + 1;

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
  paused: "paused",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

/**
 * The release of App `app`'s `version` that started a run: one no longer
 * readable (retention removed it, or it was revoked or no longer matches
 * what was sealed) leaves the run as one this screen can't see
 * (`workflow.run_unavailable`), never a `version.*` refusal, which the
 * screen would take for its own release having changed.
 */
const originRelease = async (
  env: Env,
  app: AppId,
  version: number
): Promise<Release> => {
  try {
    return await loadRelease(env, app, version);
  } catch (error) {
    if (versionErrors.codeOf(error) !== undefined) {
      throw workflowResourceErrors.create("workflow.run_unavailable");
    }
    throw error;
  }
};

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
          await originRelease(env, asking.app, originAppVersion),
          resolved.alias
        );
  if (started === undefined) {
    throw workflowResourceErrors.create("workflow.run_unavailable");
  }
  return { fingerprint: started.fingerprint, output: started.declared.output };
};

/**
 * Which of `versions`, versions of App `app` that started runs of `alias`,
 * a screen of `release` can follow such a run of: one whose release still
 * loads and declares `alias` under the contract `release` declares it
 * with. A run any other version started is refused (`startedContract`),
 * or its snapshot pins another contract than the screen's reference, which
 * the SDK refuses.
 */
export const followableOrigins = async (
  env: Env,
  app: AppId,
  release: Release,
  alias: string,
  versions: ReadonlySet<number>
): Promise<ReadonlySet<number>> => {
  const current = await declaredIn(release, alias);
  if (current === undefined) {
    return new Set();
  }
  const fingerprintOf = async (
    version: number
  ): Promise<string | undefined> => {
    if (version === release.manifest.resourceVersion) {
      return current.fingerprint;
    }
    try {
      const origin = await originRelease(env, app, version);
      const started = await declaredIn(origin, alias);
      return started?.fingerprint;
    } catch (error) {
      if (workflowResourceErrors.codeOf(error) === undefined) {
        throw error;
      }
      return undefined;
    }
  };
  // One read per App version on a page: a handful at most.
  const checked = await Promise.all(
    [...versions].map(async (version) => ({
      version,
      fingerprint: await fingerprintOf(version),
    }))
  );
  return new Set(
    checked
      .filter(({ fingerprint }) => fingerprint === current.fingerprint)
      .map(({ version }) => version)
  );
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
export const outputOf = (declared: unknown, output: unknown): Json => {
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

/**
 * What run `row` waits on now, while it runs or is paused (run-waits.ts),
 * as the release's binding of its workflow (`resolved`) names it, events
 * the person may send it now (`canSend`) sendable.
 */
const waitsOf = async (
  env: Env,
  row: RunRow,
  resolved: Resolved,
  canSend: boolean
): Promise<Json[]> =>
  row.status === "running" || row.status === "paused"
    ? await runWaits(
        env,
        {
          id: row.id,
          workflowId: row.workflowResourceId,
          version: row.version,
          manifestHash: row.manifestHash,
        },
        resolved.declared,
        canSend
      )
    : [];

/**
 * A run's status as its snapshot shows it: a running run held for its AI
 * provider (ai-waits.ts) shows queued, as its summary does, since it goes
 * on by itself once calls work; never with a wait open (`openWaits`),
 * which a queued run has none of.
 */
const shownStatus = async (
  env: Env,
  row: RunRow,
  openWaits: number
): Promise<(typeof statusOf)[keyof typeof statusOf]> => {
  if (row.status !== "running" || openWaits > 0) {
    return statusOf[row.status];
  }
  const held = await aiWaitsOf(drizzle(env.DB), [row.id]);
  return held.has(row.id) ? "queued" : "running";
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
  const seen = await seenRun(env, asking, resolved.alias, pin, runId);
  const { originAppVersion } = seen;
  // The run and the control it has applying, read together: one moment of
  // it, under the revision its row says (`summary_revision`, which every
  // write that changes either moves on in that write).
  const [row, pending] = await runAndPending(env, seen.row);
  const ended = isEnded(row.status);
  const mayStart = await holds(env, mayStartSql(asking, resolved.alias, pin));
  // Read after the row: a wait opened or closed since moves its revision on.
  const waits = await waitsOf(
    env,
    row,
    resolved,
    !ended && (await holds(env, maySendSql(asking, resolved.alias, pin)))
  );
  const status = await shownStatus(env, row, waits.length);
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
    startedAt: row.status === "starting" ? null : row.createdAt.getTime(),
    finishedAt: row.endedAt === null ? null : row.endedAt.getTime(),
    waits,
    control: {
      canPause:
        mayStart &&
        pending === undefined &&
        (row.status === "starting" || row.status === "running"),
      canResume: mayStart && pending === undefined && row.status === "paused",
      canCancel: !ended && pending !== "cancel" && mayStart,
      pendingControl:
        pending === undefined ? null : { kind: pending, stage: "applying" },
    },
    ...(output === undefined ? {} : { output }),
    ...(row.status === "failed" ? { error: failureOf(result.error) } : {}),
  };
  return { value, revision: revisionOf(generation, row) };
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
    bindingPinnedSql(asking.app, resolved.alias, pin),
    undefined,
    null,
    // The App's files the person may read now, which its run gets copies of.
    screenStartFiles(env, asking.by, asking.app, asking.release)
  );
  return {
    runId: start.id,
    workflowId: start.workflowId,
    workflowVersion: start.version,
    manifestHash: start.manifestHash,
  };
};

/** Run `runId`'s control receipts, settled or not. */
const receiptsOf = async (
  env: Env,
  runId: string
): Promise<ResourceControlRow[]> =>
  await drizzle(env.DB)
    .select()
    .from(workflowResourceRunControls)
    .where(eq(workflowResourceRunControls.runId, runId));

/** A key a pause or resume of a run was asked under, and its receipt. */
type ControlKey = typeof workflowResourceRunControlKeys.$inferSelect;

/** The keys run `runId`'s pauses and resumes were asked under. */
const keysOf = async (env: Env, runId: string): Promise<ControlKey[]> =>
  await drizzle(env.DB)
    .select()
    .from(workflowResourceRunControlKeys)
    .where(eq(workflowResourceRunControlKeys.runId, runId));

/**
 * The receipt a request for `kind` under `key` was answered before, if
 * any: a cancel's, whatever its key; a pause's or resume's, its own or the
 * one it joined, as its key has it.
 */
const answeredBefore = (
  receipts: readonly ResourceControlRow[],
  keys: readonly ControlKey[],
  kind: ResourceControlRow["kind"],
  key: string
): ResourceControlRow | undefined => {
  if (kind === "cancel") {
    return receipts.find((receipt) => receipt.kind === "cancel");
  }
  const keyed = keys.find((each) => each.kind === kind && each.key === key);
  return keyed === undefined
    ? receipts.find((receipt) => receipt.kind === kind && receipt.key === key)
    : receipts.find(({ id }) => id === keyed.receiptId);
};

/**
 * Keeps `key` of a pause or resume that joined `receipt`, unresolved, of
 * run `runId`, and answers the receipt the key has: `receipt`, or the one
 * a request under the same key was given first, by the key's uniqueness.
 */
const joinKey = async (
  env: Env,
  runId: string,
  kind: "pause" | "resume",
  key: string,
  receipt: ResourceControlRow
): Promise<ResourceControlRow> => {
  try {
    await drizzle(env.DB)
      .insert(workflowResourceRunControlKeys)
      .values({ runId, kind, key, receiptId: receipt.id });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
  }
  const [receipts, keys] = await Promise.all([
    receiptsOf(env, runId),
    keysOf(env, runId),
  ]);
  return answeredBefore(receipts, keys, kind, key) ?? receipt;
};

/**
 * A receipt of run `runId`, as a screen is answered it: its kind and
 * state, under the revision of the run's snapshot now, which shows it
 * (`summary_revision` moves on as a receipt is admitted or settled).
 */
const receiptAnswer = async (
  env: Env,
  runId: string,
  workflowId: string,
  receipt: Pick<ResourceControlRow, "kind" | "state">
): Promise<Json> => {
  const generation = await generationOf(env, workflowId);
  const row = await runOf(env, runId);
  if (row === undefined) {
    throw workflowResourceErrors.create("workflow.run_unavailable");
  }
  return {
    kind: receipt.kind,
    state: receipt.state,
    revision: revisionOf(generation, row),
  };
};

/** Where the engine has a run as its controls are decided. */
type Live = Awaited<ReturnType<ReturnType<typeof runEngine>["status"]>>;

/** Engine statuses of a run that has ended. */
const endedLive = new Set(["complete", "errored", "terminated"]);

/** What a screen's request for a control of a run comes to. */
type Admission =
  | { type: "admit" }
  | { type: "done" }
  | { type: "answer"; receipt: ResourceControlRow }
  | { type: "join"; receipt: ResourceControlRow }
  | {
      type: "refused";
      code:
        | "workflow.control_conflict"
        | "workflow.control_refused"
        | "workflow.control_rolling_back";
    };

/**
 * What a request for `kind` of run `row` under `key` comes to, with the
 * run's receipts and the keys they were asked under, and where the engine
 * has it (`live`; nothing when it has no record yet, or couldn't say for a
 * cancel). See the header.
 */
const admissionOf = (
  row: RunRow,
  receipts: readonly ResourceControlRow[],
  keys: readonly ControlKey[],
  kind: ResourceControlRow["kind"],
  key: string,
  live: Live
): Admission => {
  // The same request again (a cancel under any key), settled or not: what
  // it was answered first, the receipt it joined included.
  const same = answeredBefore(receipts, keys, kind, key);
  if (same !== undefined) {
    return { type: "answer", receipt: same };
  }
  const unresolved = receipts.filter(({ state }) => state === "admitted");
  const joined = unresolved.find((receipt) => receipt.kind === kind);
  if (joined !== undefined) {
    return { type: "join", receipt: joined };
  }
  if (live?.status === "rollingBack") {
    return { type: "refused", code: "workflow.control_rolling_back" };
  }
  if (kind === "cancel") {
    if (!isEnded(row.status)) {
      return { type: "admit" };
    }
    // Nothing to stop: a cancelled run's cancel is done; any other end
    // can't be undone.
    return row.status === "cancelled"
      ? { type: "done" }
      : { type: "refused", code: "workflow.control_refused" };
  }
  if (
    isEnded(row.status) ||
    (live !== undefined && endedLive.has(live.status))
  ) {
    return { type: "refused", code: "workflow.control_refused" };
  }
  if (unresolved.length > 0) {
    // A cancel asked, or the other of pause and resume unresolved.
    return { type: "refused", code: "workflow.control_conflict" };
  }
  const paused =
    live?.status === "paused" || live?.status === "waitingForPause";
  const already = kind === "pause" ? live?.status === "paused" : !paused;
  return already ? { type: "done" } : { type: "admit" };
};

/** What a screen's pause or resume is audited as. */
const requestedAction = {
  pause: "workflow.run.pause_requested",
  resume: "workflow.run.resume_requested",
} as const;

/**
 * Writes the receipt for `kind` of run `row` under `key`, only while the
 * person may still start the workflow through the binding and nobody
 * admitted a control of the run since `row` was read, read in the
 * statements that write it: admitted under the run's next control
 * generation, the snapshot moving on with it; or, for a request the run is
 * already past (`done`), applied at once under the current one. A cancel
 * takes the next generation too, so a pause or resume admitted before it
 * is superseded unsent (resource-runs.ts, `applyResourceControl`), or by
 * the run's end at the latest. A pause or resume is audited as asked, under the App's screen, naming the
 * person (a cancel's stop is, as it is first asked: `applyCancel`).
 * Whether it was written.
 */
const writeReceipt = async (
  env: Env,
  asking: Asking,
  may: SQL,
  row: RunRow,
  kind: ResourceControlRow["kind"],
  key: string,
  done: boolean
): Promise<string | undefined> => {
  const db = drizzle(env.DB);
  const id = crypto.randomUUID();
  const now = Date.now();
  const generation = done ? row.controlGeneration : row.controlGeneration + 1;
  // Every column by its name, in the table's order: drizzle refuses a
  // select that doesn't match the table, so a column the table gains (or
  // one moved) fails here, never takes a value meant for another.
  const insert = (condition: SQL) =>
    db.insert(workflowResourceRunControls).select(
      db
        .select({
          id: sql<string>`${id}`.as("id"),
          runId: workflowResourceRuns.id,
          appId: sql<string>`${asking.app}`.as("app_id"),
          principalId: sql<string>`${asking.by.userId}`.as("principal_id"),
          key: sql<string>`${key}`.as("key"),
          kind: sql<ResourceControlRow["kind"]>`${kind}`.as("kind"),
          state: sql<
            ResourceControlRow["state"]
          >`${done ? "applied" : "admitted"}`.as("state"),
          createdAt: sql<Date>`${now}`.as("created_at"),
          settledAt: sql<Date | null>`${done ? now : null}`.as("settled_at"),
          attempts: sql<number>`0`.as("attempts"),
          nextAt: sql<Date>`${now + cancelRepairAfterMs}`.as("next_at"),
          stopRequestedAt: sql<Date | null>`NULL`.as("stop_requested_at"),
          generation: sql<number>`${generation}`.as("generation"),
        })
        .from(workflowResourceRuns)
        .where(and(eq(workflowResourceRuns.id, row.id), condition))
    );
  const written = sql`EXISTS (SELECT 1 FROM ${workflowResourceRunControls} WHERE ${workflowResourceRunControls.id} = ${id})`;
  // A pause's or resume's key, with its receipt, in the same batch: a key
  // another request took first (one that joined) fails the whole write.
  const keyed =
    kind === "cancel"
      ? []
      : [
          db.insert(workflowResourceRunControlKeys).select(
            db
              .select({
                runId: workflowResourceRunControls.runId,
                kind: sql<"pause" | "resume">`${kind}`.as("kind"),
                key: sql<string>`${key}`.as("key"),
                receiptId: workflowResourceRunControls.id,
              })
              .from(workflowResourceRunControls)
              .where(eq(workflowResourceRunControls.id, id))
          ),
        ];
  const entry: AuditEntry | undefined =
    kind === "cancel"
      ? undefined
      : {
          ...runEntry(row, requestedAction[kind]),
          actor: { type: "app", appId: asking.app, part: "screen" },
          detail: {
            ...runEntry(row, requestedAction[kind]).detail,
            onBehalfOf: asking.by.userId,
            control: id,
            // The run already where it asked: applied as it was written.
            ...(done ? { already: true } : {}),
          },
        };
  const unchanged = and(
    eq(workflowResourceRuns.id, row.id),
    eq(workflowResourceRuns.controlGeneration, row.controlGeneration),
    inArray(workflowResourceRuns.status, unended)
  );
  try {
    await (done
      ? auditedBatch(env, db, [
          insert(
            sql`${may} AND EXISTS (SELECT 1 FROM ${workflowResourceRuns} WHERE ${and(eq(workflowResourceRuns.id, row.id), eq(workflowResourceRuns.controlGeneration, row.controlGeneration))})`
          ),
          ...keyed,
          ...(entry === undefined ? [] : [outboxedWhere(db, entry, written)]),
        ])
      : auditedBatch(env, db, [
          db
            .update(workflowResourceRuns)
            .set({
              controlGeneration: generation,
              summaryRevision: sql`${workflowResourceRuns.summaryRevision} + 1`,
            })
            .where(and(unchanged, may)),
          insert(sql`changes() > 0`),
          ...keyed,
          ...(entry === undefined ? [] : [outboxedWhere(db, entry, written)]),
        ]));
  } catch (error) {
    // A twin written first (a cancel under any key, a pause or resume
    // under this one, its own or joined to another): answered by the caller, its audit with it unwritten.
    // The unique indexes are the guard, as the generation is none for a
    // request the run is already past.
    if (!isUniqueViolation(error)) {
      throw error;
    }
  }
  const found = await db
    .select({ id: workflowResourceRunControls.id })
    .from(workflowResourceRunControls)
    .where(eq(workflowResourceRunControls.id, id))
    .get();
  return found?.id;
};

/** What deciding a control comes to: a receipt, done at once, or refused. */
type Decided =
  | { type: "receipt"; receipt: ResourceControlRow }
  | { type: "applied" }
  | {
      type: "refused";
      code:
        | "workflow.control_conflict"
        | "workflow.control_refused"
        | "workflow.control_rolling_back"
        | "workflow.start_denied";
    };

/**
 * Decides `command` of run `row` as it is (see the header): the receipt
 * it is answered, written now or found; a cancel of a cancelled run done;
 * or why it is refused.
 */
const decide = async (
  env: Env,
  asking: Asking,
  may: SQL,
  row: RunRow,
  command: Extract<WorkflowCommand, { command: "pause" | "resume" | "cancel" }>
): Promise<Decided> => {
  const kind = command.command;
  // The receipts before the engine, both after `row`: a control admitted
  // since `row` moved the run's generation on, so the write below fails;
  // one admitted before it is either unresolved here (joined or a
  // conflict) or settled, which only happens once the engine took it, so
  // the status read after shows it. Read the other way round, a control
  // settling between the two reads would make the run look already past
  // a request it isn't, and that request be applied at once unsent.
  const [receipts, keys] = await Promise.all([
    receiptsOf(env, row.id),
    keysOf(env, row.id),
  ]);
  let live: Live;
  if (!isEnded(row.status)) {
    try {
      live = await runEngine(env).status(row.id);
    } catch (error) {
      // A cancel goes ahead without the engine's word, as it always has;
      // a pause or resume needs it to know what the run is past.
      if (kind !== "cancel") {
        throw error;
      }
    }
  }
  const admission = admissionOf(
    row,
    receipts,
    keys,
    kind,
    command.idempotencyKey,
    live
  );
  if (admission.type === "refused") {
    return admission;
  }
  if (admission.type === "answer") {
    return { type: "receipt", receipt: admission.receipt };
  }
  if (admission.type === "join" && kind !== "cancel") {
    return {
      type: "receipt",
      receipt: await joinKey(
        env,
        row.id,
        kind,
        command.idempotencyKey,
        admission.receipt
      ),
    };
  }
  if (admission.type === "done" && kind === "cancel") {
    return { type: "applied" };
  }
  const written = await writeReceipt(
    env,
    asking,
    may,
    row,
    kind,
    command.idempotencyKey,
    admission.type === "done"
  );
  const [after, afterKeys] = await Promise.all([
    receiptsOf(env, row.id),
    keysOf(env, row.id),
  ]);
  // Its own; or a twin written first, under this key (its own or joined
  // to another) or, a cancel's, another; or one of its kind admitted
  // meanwhile under another key, which it joins, keeping its key.
  let receipt =
    after.find(({ id }) => id === written) ??
    answeredBefore(after, afterKeys, kind, command.idempotencyKey);
  const unresolved = after.find(
    (each) => each.kind === kind && each.state === "admitted"
  );
  if (receipt === undefined && unresolved !== undefined) {
    receipt =
      kind === "cancel"
        ? unresolved
        : await joinKey(env, row.id, kind, command.idempotencyKey, unresolved);
  }
  if (receipt === undefined) {
    // Another control admitted meanwhile, or the person may no longer.
    const stillMay = await holds(env, may);
    return {
      type: "refused",
      code: stillMay ? "workflow.control_conflict" : "workflow.start_denied",
    };
  }
  if (receipt.id === written) {
    await tellQueryFollowers(env, row.id);
  }
  return { type: "receipt", receipt };
};

/** Audits a screen's control of run `row` refused for `code`. */
const auditRefused = async (
  env: Env,
  asking: Asking,
  row: RunRow,
  kind: ResourceControlRow["kind"],
  code: string
): Promise<void> => {
  const db = drizzle(env.DB);
  const entry = runEntry(row, "workflow.run.control_refused");
  await auditedBatch(env, db, [
    outboxed(db, {
      ...entry,
      actor: { type: "app", appId: asking.app, part: "screen" },
      detail: { ...entry.detail, kind, code, onBehalfOf: asking.by.userId },
    }),
  ]);
};

/**
 * The control `command` asks of a run, decided (see the header): its
 * receipt, admitted and applied at once, or answered again; a refusal
 * throws.
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
  const kind = command.command;
  const may = mayStartSql(asking, resolved.alias, pin);
  const answer = async (receipt: Pick<ResourceControlRow, "kind" | "state">) =>
    await receiptAnswer(env, row.id, row.workflowResourceId, receipt);
  let receipt: ResourceControlRow | undefined;
  // A cancel that lost its write to a control admitted at once is decided
  // again, once, against the run as it is then: a cancel always wins.
  for (let attempt = 0; receipt === undefined; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- once more at most
    const current = attempt === 0 ? row : ((await runOf(env, row.id)) ?? row);
    // oxlint-disable-next-line no-await-in-loop -- once more at most
    const decided = await decide(env, asking, may, current, command);
    if (decided.type === "applied") {
      // oxlint-disable-next-line no-await-in-loop -- done: the last turn
      return await answer({ kind, state: "applied" });
    }
    if (decided.type === "receipt") {
      ({ receipt } = decided);
    } else if (
      kind !== "cancel" ||
      attempt > 0 ||
      decided.code !== "workflow.control_conflict"
    ) {
      // oxlint-disable-next-line no-await-in-loop -- refused: the last turn
      await auditRefused(env, asking, current, kind, decided.code);
      throw decided.code === "workflow.start_denied"
        ? workflowResourceErrors.create(decided.code)
        : workflowErrors.create(decided.code);
    }
  }
  if (receipt.state === "admitted") {
    try {
      await (receipt.kind === "cancel"
        ? applyCancel(env, receipt, row.id)
        : applyResourceControl(env, receipt));
      const settled = await receiptsOf(env, row.id);
      const { id: asked } = receipt;
      receipt = settled.find(({ id }) => id === asked) ?? receipt;
    } catch (error) {
      // Admitted all the same, which is what the screen is answered: the
      // repair applies it again (resource-runs.ts, `repairAdmittedCancels`).
      log.error("workflow.resource_run_control_failed", {
        runId: row.id,
        kind: receipt.kind,
        ...errorFields(error),
      });
    }
  }
  return await answer(receipt);
};

/**
 * Who a screen's send comes from, as its event's source: the App, the
 * release and the person the request is authenticated as, never anything
 * the request says.
 */
const sourceOf = (asking: Asking): string =>
  `urn:grasp:app:${asking.app}:version:${asking.version}:person:${encodeURIComponent(asking.by.userId)}`;

/**
 * Who a screen's send counts against in a run's inbox: the App and the
 * person, whatever release, so a new release is no fresh share.
 */
const senderOf = (asking: Asking): string =>
  `app:${asking.app}:person:${asking.by.userId}`;

/**
 * The event `command` sends to the asking person's run, admitted to its
 * inbox (see the header): its ID, the same for the same key.
 */
const sent = async (
  env: Env,
  asking: Asking,
  resolved: Resolved,
  command: Extract<WorkflowCommand, { command: "send" }>
): Promise<Json> => {
  const pin = pinOf(resolved);
  const { alias, type, fingerprint } = command.event;
  const declared = Object.hasOwn(resolved.declared.events, alias)
    ? resolved.declared.events[alias]
    : undefined;
  if (declared === undefined) {
    throw operationErrors.create("operation.not_found");
  }
  if (
    declared.type !== type ||
    (await eventFingerprint(declared)) !== fingerprint
  ) {
    throw versionErrors.create("version.mismatch");
  }
  const { row } = await seenRun(
    env,
    asking,
    resolved.alias,
    pin,
    command.runId
  );
  const checked = schemaFromDescriptor(JSON.stringify(declared.data))[
    "~standard"
  ].validate(command.data);
  if (checked instanceof Promise || checked.issues !== undefined) {
    throw operationErrors.create("contract.invalid_args");
  }
  const delivery = {
    workflowId: pin.workflowId,
    runId: row.id,
    binding: alias,
    type,
    data: checked.value,
    key: command.idempotencyKey,
    source: sourceOf(asking),
    sender: senderOf(asking),
  };
  // Refused only once it is known the run didn't take this send already:
  // one sent again, its answer lost, is answered with its event whatever
  // changed since (`unlessAccepted`); the same key with other data is a
  // conflict.
  const refuse = async (refusal: Error) =>
    await unlessAccepted(env, delivery, refusal);
  let admitted: AdmittedEvent;
  if (!(await holds(env, maySendSql(asking, resolved.alias, pin)))) {
    admitted = await refuse(
      workflowResourceErrors.create("workflow.event_denied")
    );
  } else if (
    !row.restricted &&
    (await appHost(env, asking.app).isRestricted())
  ) {
    // What a restricted App's screen sends may carry what it read: never
    // into a run that isn't restricted itself (restricted.ts).
    admitted = await refuse(permissionErrors.create("permission.restricted"));
  } else {
    admitted = await admitRunEvent(env, delivery);
  }
  const db = drizzle(env.DB);
  // Every send the run took, a resend of one too: a resend may follow a
  // first answer lost before it was recorded here.
  await auditedBatch(env, db, [
    outboxed(db, {
      // The person, whose click on the App's screen sent it.
      actor: { type: "person", userId: asking.by.userId },
      action: "workflow.event.sent",
      target: { type: "workflow_run", id: row.id },
      detail: {
        event: admitted.id,
        workflow: pin.workflowId,
        version: pin.version,
        binding: alias,
        type,
        app: asking.app,
        appVersion: asking.version,
        via: "screen",
        redelivered: !admitted.accepted,
      },
    }),
  ]);
  return { eventId: admitted.id };
};

/**
 * Answers a screen's workflow command `command` for `by` through App
 * `app`: a start's run handle, a control's receipt, or a send's event ID;
 * a refusal throws.
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
  let value: Json;
  if (command.command === "start") {
    value = await started(env, asking, resolved, command);
  } else if (command.command === "send") {
    value = await sent(env, asking, resolved, command);
  } else {
    value = await controlled(env, asking, resolved, command);
  }
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
