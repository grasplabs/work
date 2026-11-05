import { appErrors } from "@grasp-os/shared/apps";
import type { AppStatus } from "@grasp-os/shared/apps";
import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { createAuditEvent, runActorOf } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import type { AppId, RunId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { roleSchema } from "@grasp-os/shared/roles";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type { RunFailure, WorkflowRun } from "@grasp-os/shared/workflows";
import type { InstanceStatus } from "@grasp-os/workerflow/contracts";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";

import { requireStillOpen } from "../app-access.ts";
import {
  auditedBatch,
  outboxed,
  outboxedEventWhere,
  outboxedIfChanged,
  outboxedWhere,
} from "../audit-outbox.ts";
import { currentMembership } from "../auth/auth.ts";
import type { Member } from "../auth/identity.ts";
import { deliverRunCapturesSoon, runCaptured } from "../brain-capture.ts";
import {
  apps,
  members,
  workflowRunControls,
  workflowRuns,
} from "../db/core/schema.ts";
import type { RunWait } from "./admission.ts";
import { runEngine } from "./engine.ts";
import type { WaitReason } from "./host.ts";

// Runs of Apps' workflows, as core keeps them: one row each (the App
// version it is pinned to, who started it, where the engine last said it
// is), next to the run itself in the engine (engine.ts), under the same ID.
// The dispatcher (dispatcher.ts) loads a run from its row on every
// activation.
//
// One writer: the engine alone decides where a run is. The row's status
// follows the engine's notifications, each applied only if it is newer
// than the last one the row took (`projectStatus`), and an ended run's
// row never changes status again. Core writes only what is its own: the
// start it is to send (`pending_start`, until the engine confirms it), a
// start that failed before the engine had it (`failStart`), a run's
// failure report, and the cancel tombstone (`cancel_requested_at`), after
// which the dispatcher runs nothing more of the run.

export type RunRow = typeof workflowRuns.$inferSelect;

/**
 * A run's next summary revision (summary.ts), for the write that changes
 * what its summary shows.
 */
export const nextRevision = sql`${workflowRuns.summaryRevision} + 1`;

/**
 * The statuses of a run that hasn't ended. A run is `starting` from its
 * row until the engine's first notification of it; then where the engine
 * says it is.
 */
export const unended: RunRow["status"][] = ["starting", "running", "paused"];

/**
 * Whether a row's run goes on (starting or running): the runs a step of
 * which may wait in the queue for a share (admission.ts, `runActive`).
 */
export const goesOn = (status: RunRow["status"]): boolean =>
  status === "starting" || status === "running";

/** A row's status as callers see it: a run starting shows as running. */
export const shownStatus = (
  status: RunRow["status"]
): Exclude<RunRow["status"], "starting"> =>
  status === "starting" ? "running" : status;

/**
 * The most input a run starts with, in bytes of its UTF-8 JSON: the public
 * operation input limit (spec 18.1), whoever starts the run.
 */
export const maxInputBytes = platformLimits.operationInputBytes;

/** The bytes of `value` as UTF-8 JSON. */
export const jsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

/**
 * Whether `by` sees what a run read, returned and failed with: an admin,
 * or the person it acts for, who started it or, for a run a trigger
 * started, the App's owner (`ownerId`, now). A failed run's report is
 * here: `status`, and `list` for all of an App's runs.
 */
export const seesDetails = (
  by: Member,
  row: RunRow,
  ownerId: string
): boolean => by.role === "admin" || by.userId === (row.startedBy ?? ownerId);

/** What runs need of their App: its current version and its owner. */
export const appRecord = async (
  env: Env,
  app: AppId
): Promise<{
  currentVersion: number | null;
  ownerId: string;
  status: AppStatus;
}> => {
  const found = await drizzle(env.DB)
    .select({
      currentVersion: apps.currentVersion,
      ownerId: apps.ownerId,
      status: apps.status,
    })
    .from(apps)
    .where(eq(apps.id, app))
    .get();
  if (!found) {
    throw appErrors.create("app.not_found");
  }
  return found;
};

/** The run's row, if there is one. */
export const findRun = async (
  env: Env,
  run: RunId
): Promise<RunRow | undefined> =>
  await drizzle(env.DB)
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, run))
    .get();

/** The audit entry of something that happened to a run. */
export const runEntry = (
  actor: AuditActor,
  action: `workflow.run.${string}`,
  row: Pick<RunRow, "id" | "appId" | "workflowId" | "version">,
  detail: Record<string, string | number | boolean | null> = {}
): AuditEntry => ({
  actor,
  action,
  target: { type: "workflow_run", id: row.id },
  detail: {
    app: row.appId,
    workflow: row.workflowId,
    version: row.version,
    ...detail,
  },
});

/** The run's own actor in the audit log. */
export const runActor = (
  row: Pick<RunRow, "id" | "appId" | "workflowId"> &
    Partial<Pick<RunRow, "rootRunId">>
): AuditActor =>
  runActorOf({
    runId: row.id,
    app: row.appId,
    workflow: row.workflowId,
    rootRunId: row.rootRunId,
  });

/**
 * The statement that records a run's failure, after the one that marks it
 * failed in the same batch: its `workflow.run.failed` event, stored only
 * if that statement changed the row, so a run that ended otherwise records
 * nothing.
 */
const failureRecorded = (
  db: DrizzleD1Database,
  row: Pick<RunRow, "id" | "appId" | "workflowId" | "version" | "startedBy">,
  detail: Record<string, string | number | boolean | null>,
  also: SQL = sql`1`
) =>
  [
    outboxedEventWhere(
      db,
      createAuditEvent(
        runEntry(runActor(row), "workflow.run.failed", row, detail),
        "core"
      ),
      sql`changes() > 0 AND ${also}`
    ),
  ] as const;

/** What core sends the engine to start `row`'s run (engine.ts). */
const sendStart = async (
  env: Env,
  row: Pick<RunRow, "id" | "appId" | "workflowId" | "version">,
  input: Json | undefined
): Promise<void> => {
  await runEngine(env).create({
    id: row.id,
    pinned: {
      app: appIdSchema.parse(row.appId),
      workflow: workflowIdSchema.parse(row.workflowId),
      version: row.version,
    },
    input,
  });
};

/**
 * Sends `row`'s start again, the same, while the engine is still to
 * confirm it: the engine takes it as the start it already has, if it has
 * it, so the run is started once however often this runs. Never a run
 * cancelled meanwhile: the repair ends that one (`repairStart`).
 */
const resendStart = async (env: Env, row: RunRow): Promise<void> => {
  if (
    row.pendingStart === null ||
    row.status !== "starting" ||
    row.cancelRequestedAt !== null
  ) {
    return;
  }
  await sendStart(env, row, row.pendingStart.input);
};

/**
 * Why a run is marked failed without having run: its engine instance
 * couldn't be created (`start_failed`, `startRun`), or it was never
 * confirmed however often it was sent again (`no_instance`,
 * `repairStarts`). Each with the message its report says it with.
 */
const unstarted = {
  start_failed: "The workflow run couldn't be started.",
  app_archived: "The App was archived before the run started.",
  app_unpublished:
    "The App was taken back to a draft before its trigger's run started.",
  starter_refused:
    "Whoever started it could no longer use the App when it would have started.",
  no_instance: "The engine has no record of this run.",
} as const;

/**
 * Marks a run whose start the engine never confirmed as failed, for
 * `reason`, audited as a failed run (`failureRecorded`),
 * once: core's own decision that the run didn't start, and its tombstone.
 * Only a starting run: one the engine has told of meanwhile stays as the
 * engine says. Should the engine have it after all (the answer to its
 * start was lost), the dispatcher runs none of it, as the row has ended.
 * Its report, which its owner sees as they see any failed run's, says
 * only that it didn't start. It gives up its trigger key, so its trigger
 * delivered again starts a new run. A run cancelled meanwhile ends
 * cancelled instead, keeping its key. Whether this ended it.
 */
const failStart = async (
  env: Env,
  row: Pick<RunRow, "id" | "appId" | "workflowId" | "version" | "startedBy">,
  reason: keyof typeof unstarted
): Promise<boolean> => {
  const db = drizzle(env.DB);
  const failedAt = new Date();
  const failure: RunFailure = {
    run: runIdSchema.parse(row.id),
    app: appIdSchema.parse(row.appId),
    workflow: workflowIdSchema.parse(row.workflowId),
    version: row.version,
    step: null,
    input: null,
    error: { code: "workflow.run_failed", message: unstarted[reason] },
    failedAt: failedAt.toISOString(),
  };
  const [[failed]] = await auditedBatch(env, db, [
    db
      .update(workflowRuns)
      // A run cancelled meanwhile (as the row is now, in this write) ends
      // cancelled: its cancel was audited when asked for, nobody is told
      // of a failure, and it keeps its trigger key, so a delivery of its
      // trigger again finds the run that was cancelled rather than
      // starting the work anew.
      .set({
        status: sql`CASE WHEN ${workflowRuns.cancelRequestedAt} IS NULL THEN 'failed' ELSE 'cancelled' END`,
        endedAt: failedAt,
        failure: sql`CASE WHEN ${workflowRuns.cancelRequestedAt} IS NULL THEN ${JSON.stringify(failure)} ELSE NULL END`,
        triggerKey: sql`CASE WHEN ${workflowRuns.cancelRequestedAt} IS NULL THEN NULL ELSE ${workflowRuns.triggerKey} END`,
        pendingStart: null,
        summaryRevision: nextRevision,
      })
      .where(
        and(eq(workflowRuns.id, row.id), eq(workflowRuns.status, "starting"))
      )
      .returning({ id: workflowRuns.id }),
    ...failureRecorded(
      db,
      row,
      { reason, error: "workflow.run_failed" },
      sql`EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${workflowRuns.id} = ${row.id} AND ${workflowRuns.status} = 'failed')`
    ),
    // A pause or resume admitted while it was starting has nothing left
    // to apply to: superseded, so the repair doesn't send it for ever. A
    // cancel admitted meanwhile is what ended it.
    db
      .update(workflowRunControls)
      .set({ state: "applied", settledAt: failedAt })
      .where(
        and(
          eq(workflowRunControls.runId, row.id),
          eq(workflowRunControls.state, "admitted"),
          eq(workflowRunControls.kind, "cancel"),
          sql`EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${workflowRuns.id} = ${row.id} AND ${workflowRuns.status} = 'cancelled')`
        )
      ),
    db
      .update(workflowRunControls)
      .set({ state: "superseded", settledAt: failedAt })
      .where(
        and(
          eq(workflowRunControls.runId, row.id),
          eq(workflowRunControls.state, "admitted"),
          sql`EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${workflowRuns.id} = ${row.id} AND ${workflowRuns.status} IN ('failed', 'cancelled'))`
        )
      ),
  ]);
  if (!failed) {
    return false;
  }
  // A start that reached the engine between its saying it had no record
  // of the run and this write may have begun running, its first steps
  // before the row ended: terminating it, which the engine takes once and
  // for good (nothing for a run it has no record of), stops the rest.
  // Should that fail, the run's next activation finds its row ended.
  try {
    await runEngine(env).terminate(row.id);
  } catch (error) {
    log.error("workflow.unstarted_terminate_failed", {
      runId: row.id,
      ...errorFields(error),
    });
  }
  return true;
};

/**
 * Forgets the start the engine has now confirmed: nothing sends it again.
 * Its status is the engine's to set (`projectStatus`).
 */
const startConfirmed = async (env: Env, run: string): Promise<void> => {
  await drizzle(env.DB)
    .update(workflowRuns)
    .set({ pendingStart: null })
    .where(and(eq(workflowRuns.id, run), isNotNull(workflowRuns.pendingStart)));
};

/**
 * How long a start the engine hasn't confirmed is left to the start under
 * way before the repair sends it again: longer than a start takes between
 * writing the row and the engine's answer.
 */
const repairAfterMs = 60_000;

/**
 * How long the repair sends a start again before it gives up on it: a
 * start the engine still hasn't taken by then (it kept failing) is marked
 * failed, and gives up its trigger key.
 */
const repairGivesUpAfterMs = 15 * 60_000;

/**
 * Most starts one repair sends again: a budget for one clock run. Each one
 * the engine confirms leaves the set, so the next clock run takes the next.
 */
const repairsPerRun = 50;

/**
 * Records that the engine confirmed run `run`'s start. Should D1 fail
 * here, the start is still pending, and the repair sends it again, which
 * the engine takes as the start it already has: a failure to record it is
 * never taken for a failure to start.
 */
const confirmStart = async (env: Env, run: string): Promise<void> => {
  try {
    await startConfirmed(env, run);
  } catch (error) {
    log.warn("workflow.start_not_recorded", {
      runId: run,
      ...errorFields(error),
    });
  }
};

/**
 * Whether the engine has run `run`, or nothing when it couldn't say: what
 * the repair asks before it gives a start up, as the answer to a start
 * that reached the engine may have been lost.
 */
const engineHas = async (env: Env, run: string): Promise<boolean | null> => {
  try {
    return (await runEngine(env).status(run)) !== undefined;
  } catch (error) {
    log.error("workflow.start_check_failed", {
      runId: run,
      ...errorFields(error),
    });
    return null;
  }
};

/**
 * A run as it reads with its place in the queue (admission.ts,
 * `queuedRuns`): `queued`, with the share it waits for and when it asks
 * again, or since when it waits for its AI provider, while it would otherwise read as running, or as waiting the way
 * the engine has a step that sleeps between asks. A run that is paused or
 * has ended waits for no share, whatever place may still lapse.
 */
export const queuedRun = <
  Run extends Pick<WorkflowRun, "status" | "queued" | "aiProvider">,
>(
  run: Run,
  wait: RunWait | undefined
): Run =>
  wait !== undefined && (run.status === "running" || run.status === "waiting")
    ? { ...run, status: "queued", ...wait }
    : run;

/** What a run that stopped reports: where it stopped, and why. */
export type Stopped = Pick<RunFailure, "step" | "input" | "error">;

/**
 * Keeps a failed run's report (`failed`), for its owner to see, before
 * the run ends: written by the run itself, in its last step, once. Its
 * status, and the failure's audit event and notice, follow when the
 * engine says the run has ended (`projectStatus`).
 */
export const recordFailure = async (
  env: Env,
  row: RunRow,
  failed: Stopped
): Promise<void> => {
  const failure: RunFailure = {
    run: runIdSchema.parse(row.id),
    app: appIdSchema.parse(row.appId),
    workflow: workflowIdSchema.parse(row.workflowId),
    version: row.version,
    ...failed,
    failedAt: new Date().toISOString(),
  };
  await drizzle(env.DB)
    .update(workflowRuns)
    .set({ failure, summaryRevision: nextRevision })
    .where(and(eq(workflowRuns.id, row.id), isNull(workflowRuns.failure)));
};

/** The engine's statuses of a run that has ended. */
export const endedLive: ReadonlySet<InstanceStatus["status"]> = new Set([
  "complete",
  "errored",
  "terminated",
]);

/** Where the engine says a run is, as its row keeps it. */
const projected: Record<InstanceStatus["status"], RunRow["status"]> = {
  queued: "running",
  running: "running",
  waiting: "running",
  waitingForPause: "running",
  rollingBack: "running",
  paused: "paused",
  complete: "completed",
  errored: "failed",
  terminated: "cancelled",
};

/**
 * The report of a run that ended failed without one of its own: the
 * engine ended it before its last step could write one (its definition
 * couldn't be replayed, say).
 */
const stoppedReport = (row: RunRow, at: Date): RunFailure => ({
  run: runIdSchema.parse(row.id),
  app: appIdSchema.parse(row.appId),
  workflow: workflowIdSchema.parse(row.workflowId),
  version: row.version,
  step: null,
  input: null,
  error: {
    code: "workflow.run_failed",
    message: "The workflow run stopped.",
  },
  failedAt: at.toISOString(),
});

/** The pause or resume each status of a run that hasn't ended confirms. */
/**
 * The statements that settle the run's control receipts (controls.ts) its
 * end settles, in the projection's batch, after the write of the status:
 * a cancel is applied once the run ended other than completed, and a
 * pause, a resume, or a cancel a completion overtook, is superseded. Only
 * once the row took the notification: a late one settles nothing. An end
 * is final, so its notification can't be overtaken. A pause or resume is
 * settled only from where the engine has the run as it is read
 * (controls.ts, `settleControls`), never from a notification, which may
 * be older than the receipt.
 */
const controlsSettledBy = (
  db: DrizzleD1Database,
  run: string,
  { status, sequence }: EngineStatus,
  at: Date
) => {
  if (!endedLive.has(status)) {
    return [];
  }
  const took =
    sequence === undefined
      ? undefined
      : sql`EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${workflowRuns.id} = ${run} AND ${workflowRuns.engineSequence} = ${sequence})`;
  const settled = (kinds: ("pause" | "resume" | "cancel")[]) =>
    and(
      eq(workflowRunControls.runId, run),
      eq(workflowRunControls.state, "admitted"),
      inArray(workflowRunControls.kind, kinds),
      took
    );
  // A cancel is done once the run ended other than completed (its next
  // activation refused to run on, or the engine terminated it); a run
  // that completed first overtook it, as it did a pause or a resume.
  const cancelled =
    status === "complete"
      ? []
      : [
          db
            .update(workflowRunControls)
            .set({ state: "applied", settledAt: at })
            .where(settled(["cancel"])),
        ];
  return [
    ...cancelled,
    db
      .update(workflowRunControls)
      .set({ state: "superseded", settledAt: at })
      .where(settled(["pause", "resume", "cancel"])),
  ];
};

/** Where the engine says a run is, as its notification has it. */
export interface EngineStatus {
  status: InstanceStatus["status"];
  /** When the run took the status, in ms since the epoch. */
  at: number;
  /**
   * The notification's sequence: applied only if newer than the last the
   * row took. Absent only for an end the engine confirmed just now, in
   * answer to core's own command (`cancelRun`): an ended run never
   * changes again, so nothing later can be newer.
   */
  sequence?: number;
  /**
   * When the run's first activation started, as the engine says with its
   * notifications (`firstActivatedAt`): nothing before it ran, or for an
   * end core's own command confirmed.
   */
  startedAt?: number;
  /**
   * For a run that ended having rolled back (its steps' compensations,
   * spec 10.7.3), how that went, from the engine's own record of it.
   */
  rollback?: "complete" | "errored";
  /**
   * For a run rolling back, why: its failure (with the code it failed
   * with, if any) or a cancellation, from the engine's own record.
   */
  compensation?: { cause: "failure" | "cancellation"; code: string | null };
}

/**
 * What a run whose compensation failed ends with (spec 10.7.3): failed,
 * as `workflow.compensation_failed`, whatever it failed with or was ended
 * by; both failures stay in its history, its step's and its compensation's.
 */
export const compensationFailedError = {
  code: "workflow.compensation_failed",
  message: workflowErrors.create("workflow.compensation_failed").message,
};

/**
 * What the projection of `engine` writes of the engine itself: its own
 * status, the notification's sequence (none for an end core's own command
 * confirmed), the run's next summary revision, and when it first ran:
 * written once, from the engine's own record of its first activation, so
 * a batch that skips past `running` loses nothing, and never overwritten.
 */
const engineFields = (engine: EngineStatus) => ({
  engineStatus: engine.status,
  // While it rolls back, why: what its summary says it compensates for.
  ...(engine.status === "rollingBack" && engine.compensation !== undefined
    ? { compensation: JSON.stringify(engine.compensation) }
    : {}),
  summaryRevision: nextRevision,
  ...(engine.sequence === undefined ? {} : { engineSequence: engine.sequence }),
  ...(engine.startedAt === undefined
    ? {}
    : {
        startedAt: sql`COALESCE(${workflowRuns.startedAt}, ${engine.startedAt})`,
      }),
});

/**
 * What run `row` ends with, or is, as the engine says it is (`engine`), at
 * `at`: its status, its failure report (none unless it failed), and what
 * the projection writes of them. A cancelled run the engine ended
 * otherwise than by terminating it ended for its cancel: its next
 * activation refused to run on. Whether a cancel was asked for is decided
 * in the write, as the row is then: a cancel written since `row` was read
 * makes it cancelled, not failed. A run whose compensation failed ends
 * failed, as that, however it ended (spec 10.7.3), a cancelled run's
 * included.
 */
const outcomeOf = (
  row: RunRow,
  engine: EngineStatus,
  at: Date
): {
  status: RunRow["status"];
  report: RunFailure | null;
  written: SQLiteUpdateSetSource<typeof workflowRuns>;
} => {
  if (engine.rollback === "errored") {
    const report = {
      ...stoppedReport(row, at),
      error: compensationFailedError,
    };
    return {
      status: "failed",
      report,
      written: { status: "failed", failure: report },
    };
  }
  if (engine.status !== "errored") {
    const status = projected[engine.status];
    return { status, report: null, written: { status } };
  }
  const report = row.failure ?? stoppedReport(row, at);
  return {
    status: row.cancelRequestedAt === null ? "failed" : "cancelled",
    report,
    written: {
      status: sql<
        RunRow["status"]
      >`CASE WHEN ${workflowRuns.cancelRequestedAt} IS NULL THEN 'failed' ELSE 'cancelled' END`,
      failure: sql`CASE WHEN ${workflowRuns.cancelRequestedAt} IS NULL THEN ${JSON.stringify(report)} ELSE ${workflowRuns.failure} END`,
    },
  };
};

/**
 * Makes the run's row say where the engine says it is: the one writer of
 * a run's status. A notification no newer than the last the row took is
 * late and changes nothing; an ended run's row never changes again. The
 * first one confirms the run's start, which nothing sends again. A run's
 * end is audited with its row, once: completed; failed, with its report
 * (its own, or one saying it stopped) and its owner notified; cancelled,
 * which a cancel has audited already, unless the engine ended it without
 * one. Screens are told of every change of status. An ended run's
 * outcome is captured for the Brain with its end.
 */
export const projectStatus = async (
  env: Env,
  run: string,
  engine: EngineStatus
): Promise<void> => {
  const id = runIdSchema.safeParse(run);
  const row = id.success ? await findRun(env, id.data) : undefined;
  if (row === undefined || !unended.includes(row.status)) {
    return;
  }
  const { status, report, written } = outcomeOf(
    row,
    engine,
    new Date(engine.at)
  );
  const at = new Date(engine.at);
  const db = drizzle(env.DB);
  const fenced = and(
    eq(workflowRuns.id, row.id),
    inArray(workflowRuns.status, unended),
    engine.sequence === undefined
      ? undefined
      : lt(workflowRuns.engineSequence, engine.sequence)
  );
  const ended = endedLive.has(engine.status);
  const endedFailed = sql`EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${workflowRuns.id} = ${row.id} AND ${workflowRuns.status} = 'failed')`;
  const [[changed]] = await auditedBatch(env, db, [
    db
      .update(workflowRuns)
      .set({
        ...written,
        pendingStart: null,
        ...engineFields(engine),
        ...(ended ? { endedAt: at } : {}),
      })
      .where(fenced)
      .returning({ id: workflowRuns.id, status: workflowRuns.status }),
    ...(status === "completed"
      ? [
          outboxedIfChanged(
            db,
            runEntry(runActor(row), "workflow.run.completed", row)
          ),
        ]
      : []),
    // Audited and noticed only when the write made it failed.
    ...(report === null
      ? []
      : failureRecorded(db, row, { error: report.error.code }, endedFailed)),
    // Audited by the system only when no cancel was asked for, as the
    // batch finds the row: a cancel written since `row` was read audited
    // it already, and its run is audited as cancelled once.
    ...(status === "cancelled"
      ? [
          outboxedWhere(
            db,
            runEntry({ type: "system" }, "workflow.run.cancelled", row),
            sql`changes() > 0 AND NOT EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${workflowRuns.id} = ${row.id} AND ${workflowRuns.cancelRequestedAt} IS NOT NULL)`
          ),
        ]
      : []),
    ...controlsSettledBy(db, row.id, engine, at),
    // Its outcome's capture for the Brain goes with its end: a run never
    // ends without it (brain-capture.ts).
    ...(ended ? [runCaptured(db, row.id, at)] : []),
  ]);
  if (changed && ended) {
    // The Brain gets an ended run's outcome soon.
    deliverRunCapturesSoon(env);
  }
};

/**
 * Brings run `run`'s row to its end as the engine found it ended (`live`;
 * none for a run it has no record of, which ends terminated), with how
 * its rollback went, if it rolled back: one that failed ends the run
 * failed (spec 10.7.3), whatever ended it.
 */
export const projectEnded = async (
  env: Env,
  run: string,
  live: InstanceStatus | undefined
): Promise<void> => {
  const rollback =
    live !== undefined && "rollback" in live ? live.rollback : undefined;
  await projectStatus(env, run, {
    status: live?.status ?? "terminated",
    at: Date.now(),
    ...(rollback === undefined ? {} : { rollback: rollback.status }),
  });
};

/**
 * Ends a run cancelled while its start was pending (`completeCancel`
 * keeps the start, so the repair finds the row): its start isn't sent
 * again, the engine is told to terminate whatever it has of it, and once
 * the engine has none, or has ended it, the row ends cancelled
 * (`projectStatus`), its pending start with it. What a cancel whose
 * request died before it got that far leaves behind. A failure is logged
 * and tried again by the next repair.
 */
const endCancelledStart = async (env: Env, row: RunRow): Promise<void> => {
  try {
    const engine = runEngine(env);
    await engine.terminate(row.id);
    const live = await engine.status(row.id);
    if (live === undefined || endedLive.has(live.status)) {
      await projectEnded(env, row.id, live);
    }
  } catch (error) {
    log.error("workflow.start_cancel_failed", {
      runId: row.id,
      ...errorFields(error),
    });
  }
};

/**
 * Why a start the engine has no record of must not be sent again now, as
 * `startRun` would decide it (core may have stopped before its check, or
 * that read failed): an archived App; a trigger's start on an App that
 * isn't published; a person's start once they may no longer use the App,
 * their role and teams read now. Null when it may go; undefined when it
 * can't be told now, and the next pass looks again.
 */
const repairRefusal = async (
  env: Env,
  row: RunRow
): Promise<keyof typeof unstarted | null | undefined> => {
  const app = appIdSchema.parse(row.appId);
  try {
    const { status } = await appRecord(env, app);
    if (status === "archived") {
      return "app_archived";
    }
    if (row.startedBy === null) {
      return status === "published" ? null : "app_unpublished";
    }
    const [membership] = await drizzle(env.DB)
      .select({ role: members.role })
      .from(members)
      .where(currentMembership(row.startedBy));
    const role = roleSchema.safeParse(membership?.role);
    if (!role.success) {
      return "starter_refused";
    }
    // Their teams are read again by the check itself.
    await requireStillOpen(
      env,
      { userId: row.startedBy, role: role.data, teams: [] },
      app
    );
    return null;
  } catch (error) {
    if (isExpectedError(error)) {
      return "starter_refused";
    }
    log.error("workflow.start_repair_failed", {
      runId: row.id,
      ...errorFields(error),
    });
    return undefined;
  }
};

/**
 * Sends `row`'s start again (`repairStarts`). A start the engine still
 * won't take `repairGivesUpAfterMs` after it was written is marked failed,
 * but only once the engine says it has no record of the run: one it has
 * is confirmed, and one it can't say of is tried again by the next repair,
 * so a start whose answer was lost is never given up while it runs. A
 * start it has no record of is sent again only while the App would admit
 * it (`repairRefusal`).
 */
const repairStart = async (env: Env, row: RunRow): Promise<void> => {
  if (row.cancelRequestedAt !== null) {
    await endCancelledStart(env, row);
    return;
  }
  // The engine first: a start it took already is a run in flight, which
  // goes on whatever became of the App since (archiving cancels it apart,
  // app-status.ts); one it can't say of waits for the next pass.
  const taken = await engineHas(env, row.id);
  if (taken === null) {
    return;
  }
  if (taken) {
    await confirmStart(env, row.id);
    return;
  }
  const refused = await repairRefusal(env, row);
  if (refused === undefined) {
    return;
  }
  if (refused !== null) {
    await failStart(env, row, refused);
    return;
  }
  try {
    log.warn("workflow.start_resent", { runId: row.id });
    await resendStart(env, row);
  } catch (error) {
    log.error("workflow.start_repair_failed", {
      runId: row.id,
      ...errorFields(error),
    });
    if (Date.now() - row.createdAt.getTime() <= repairGivesUpAfterMs) {
      return;
    }
    const has = await engineHas(env, row.id);
    if (has === false) {
      await failStart(env, row, "no_instance");
    }
    if (has !== true) {
      return;
    }
  }
  await confirmStart(env, row.id);
};

/**
 * Sends again each start the engine hasn't confirmed `repairAfterMs`
 * after its row was written: what a start leaves when core stops between
 * writing the run's row and the engine's answer. The start is sent as it
 * was first (`pending_start`), under the run's ID, so the engine takes it
 * as the start it already has if it got it, and creates the run once if
 * it didn't. A start still unconfirmed `repairGivesUpAfterMs` on is marked
 * failed (`no_instance`).
 *
 * Each clock run takes at most `repairsPerRun` of them, in ID order from a
 * random ID (`from`), wrapping round: starts the engine keeps failing on
 * can't hold every run's budget, and every one is reached in time.
 */
export const repairStarts = async (
  env: Env,
  from: string = crypto.randomUUID()
): Promise<void> => {
  const db = drizzle(env.DB);
  const cutoff = new Date(Date.now() - repairAfterMs);
  const slice = async (side: SQL, limit: number): Promise<RunRow[]> =>
    await db
      .select()
      .from(workflowRuns)
      .where(
        and(
          isNotNull(workflowRuns.pendingStart),
          lt(workflowRuns.createdAt, cutoff),
          side
        )
      )
      .orderBy(asc(workflowRuns.id))
      .limit(limit);
  const onward = await slice(gte(workflowRuns.id, from), repairsPerRun);
  const rows =
    onward.length < repairsPerRun
      ? [
          ...onward,
          ...(await slice(
            lt(workflowRuns.id, from),
            repairsPerRun - onward.length
          )),
        ]
      : onward;
  // Each on its own: one the engine or D1 fails on is tried again by the
  // next clock run, and holds up none of the others.
  await Promise.all(
    rows.map(async (row) => {
      await repairStart(env, row);
    })
  );
};

/**
 * Does in core's database what a cancel marked in the run's object
 * (`markRunCancelled`) asks: the run's row tombstoned and the cancel
 * audited, as of who cancelled it and when, once, whichever of the
 * cancel's request, a cancel asked for again, or the object's repair gets
 * there first; nothing for a run that has ended.
 */
export const completeCancel = async (
  env: Env,
  mark: { runId: string; actor: AuditActor; at: number }
): Promise<void> => {
  const id = runIdSchema.safeParse(mark.runId);
  const row = id.success ? await findRun(env, id.data) : undefined;
  if (row === undefined) {
    return;
  }
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(workflowRuns)
      // A start still pending stays, so the repair finds the row should
      // the rest of the cancel not happen, and ends it (`repairStart`).
      .set({
        cancelRequestedAt: new Date(mark.at),
        // As a cancel's receipt does (controls.ts): a pause or resume
        // admitted before it is fenced, its generation no longer the run's.
        controlGeneration: sql`${workflowRuns.controlGeneration} + 1`,
        summaryRevision: nextRevision,
      })
      .where(
        and(
          eq(workflowRuns.id, row.id),
          inArray(workflowRuns.status, unended),
          isNull(workflowRuns.cancelRequestedAt)
        )
      ),
    outboxedIfChanged(db, runEntry(mark.actor, "workflow.run.cancelled", row)),
    // A cancel supersedes every pause or resume still unresolved, however
    // it was recorded: no receipt is left admitted behind it.
    db
      .update(workflowRunControls)
      .set({ state: "superseded", settledAt: new Date() })
      .where(
        and(
          eq(workflowRunControls.runId, row.id),
          eq(workflowRunControls.state, "admitted"),
          inArray(workflowRunControls.kind, ["pause", "resume"]),
          sql`EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${workflowRuns.id} = ${row.id} AND ${workflowRuns.cancelRequestedAt} IS NOT NULL)`
        )
      ),
  ]);
};

/**
 * Records that a run waits (host.ts) while a side effect of a step waits
 * for the person it acts for, until they decided. The wait is recorded in
 * a step named after the step it holds, which every execution replays, so
 * it is recorded once.
 */
export const recordWaiting = async (
  env: Env,
  row: RunRow,
  why: WaitReason
): Promise<void> => {
  const db = drizzle(env.DB);
  const entry = runEntry(runActor(row), "workflow.run.waiting", row, {
    ...why,
  });
  await auditedBatch(env, db, [outboxed(db, entry)]);
};

/**
 * The most runs mail, or connector events, start of one workflow in an
 * hour, each counted on its own.
 */
export const triggeredRunsPerHour = 60;
