import { appErrors } from "@grasp-os/shared/apps";
import type { AppStatus } from "@grasp-os/shared/apps";
import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { createAuditEvent, runActorOf } from "@grasp-os/shared/audit";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import type { AppId, RunId } from "@grasp-os/shared/ids";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type { RunFailure, WorkflowRun } from "@grasp-os/shared/workflows";
import type { InstanceStatus } from "@grasp-os/workerflow/contracts";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";

import {
  auditedBatch,
  outboxed,
  outboxedEventWhere,
  outboxedIfChanged,
  outboxedWhere,
} from "../audit-outbox.ts";
import type { Member } from "../auth/identity.ts";
import { deliverRunCapturesSoon, runCaptured } from "../brain-capture.ts";
import { apps, workflowRunControls, workflowRuns } from "../db/core/schema.ts";
import type { RunWait } from "./admission.ts";
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
// row never changes status again. Core writes only what is its own: a
// run's failure report, and the cancel tombstone (`cancel_requested_at`),
// after which the dispatcher runs nothing more of the run. Nothing starts
// an App run any more (app-no-workflows.ts): what is left here settles the
// rows that exist, and goes with the table.

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

/**
 * A run as it reads while held for its AI provider (admission.ts,
 * `queuedRuns`): `queued`, with since when, while it would otherwise read
 * as running, or as waiting the way the engine has a step that sleeps
 * between asks. A run that is paused or has ended waits for nothing.
 */
export const queuedRun = <
  Run extends Pick<WorkflowRun, "status" | "aiProvider">,
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
