import { appErrors } from "@grasp-os/shared/apps";
import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { actorOf, createAuditEvent, runActorOf } from "@grasp-os/shared/audit";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import type { AppId, RunId, WorkflowId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type {
  RunFailure,
  RunStatus,
  WorkflowRun,
} from "@grasp-os/shared/workflows";
import type { InstanceStatus } from "@grasp-os/workerflow/contracts";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { appFor, versionFiles } from "../apps.ts";
import {
  auditedBatch,
  outboxed,
  outboxedEventWhere,
  outboxedIfChanged,
  outboxedWhere,
  storedEvent,
} from "../audit-outbox.ts";
import type { Member } from "../auth/identity.ts";
import { apps, workflowRuns } from "../db/core/schema.ts";
import { failureNoticed } from "../notifications.ts";
import { stepStatisticsForgotten } from "../statistic-steps.ts";
import { hasWorkflow } from "./code.ts";
import { markRunCancelled, runEngine, settleRunCancel } from "./engine.ts";
import type { WaitReason } from "./host.ts";
import { detailsRemoved, removedText } from "./retention.ts";
import { tellScreens } from "./run-changes.ts";
import type { TriggerType } from "./trigger-registry.ts";

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
 * The statuses of a run that hasn't ended. A run is `starting` from its
 * row until the engine's first notification of it; then where the engine
 * says it is.
 */
export const unended: RunRow["status"][] = ["starting", "running", "paused"];

/** A row's status as callers see it: a run starting shows as running. */
export const shownStatus = (
  status: RunRow["status"]
): Exclude<RunRow["status"], "starting"> =>
  status === "starting" ? "running" : status;

/** Most runs one `list` call returns. */
export const runsPerPage = 100;

/** The most input a run starts with, as JSON text. */
export const maxInputLength = 128 * 1024;

const invalid = () => workflowErrors.create("workflow.invalid");

const parse = <Schema extends z.ZodType>(
  schema: Schema,
  input: unknown
): z.output<Schema> => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw invalid();
  }
  return parsed.data;
};

/** A workflow's ID as its file names it (`workflows/<id>.ts`). */
export const workflowInputSchema = z
  .string()
  .regex(/^[A-Za-z][\w-]{0,63}$/u)
  .pipe(workflowIdSchema);

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

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

/** What a run's row holds that its callers see. */
type RunFields = Pick<
  RunRow,
  | "id"
  | "appId"
  | "workflowId"
  | "version"
  | "startedBy"
  | "status"
  | "createdAt"
  | "endedAt"
  | "detailsRemovedAt"
>;

/**
 * A run as its row has it; `status` names what the row last saw. It says
 * so once its details are removed (`detailsRemoved`, retention.ts).
 */
const toRun = (env: Env, row: RunFields): WorkflowRun => ({
  id: runIdSchema.parse(row.id),
  app: appIdSchema.parse(row.appId),
  workflow: workflowIdSchema.parse(row.workflowId),
  version: row.version,
  startedBy:
    row.startedBy === null
      ? { type: "trigger" }
      : { type: "person", userId: row.startedBy },
  status: shownStatus(row.status),
  createdAt: row.createdAt.toISOString(),
  endedAt: iso(row.endedAt),
  ...(detailsRemoved(env, row) ? { detailsRemoved: true } : {}),
});

/** What runs need of their App: its current version and its owner. */
export const appRecord = async (
  env: Env,
  app: AppId
): Promise<{ currentVersion: number | null; ownerId: string }> => {
  const found = await drizzle(env.DB)
    .select({ currentVersion: apps.currentVersion, ownerId: apps.ownerId })
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
 * The statements that record a run's failure, after the one that marks it
 * failed in the same batch: its `workflow.run.failed` event, stored only
 * if that statement changed the row, so a run that ended otherwise records
 * nothing; and the notice to the person
 * it acted for (notifications.ts), only if the event was stored. That
 * person is who started it, or for a triggered run the App's owner, read
 * now.
 */
const failureRecorded = async (
  env: Env,
  db: DrizzleD1Database,
  row: Pick<RunRow, "id" | "appId" | "workflowId" | "version" | "startedBy">,
  detail: Record<string, string | number | boolean | null>,
  also: SQL = sql`1`
) => {
  const failed = createAuditEvent(
    runEntry(runActor(row), "workflow.run.failed", row, detail),
    "core"
  );
  const stored = outboxedEventWhere(db, failed, sql`changes() > 0 AND ${also}`);
  let personId = row.startedBy;
  if (personId === null) {
    const app = await appRecord(env, appIdSchema.parse(row.appId));
    personId = app.ownerId;
  }
  return [
    stored,
    ...failureNoticed(db, {
      run: row,
      personId,
      entry: runEntry(runActor(row), "workflow.run.notified", row, {
        person: personId,
      }),
      recorded: storedEvent(failed.id),
    }),
  ] as const;
};

/** What starts a run: which workflow, with what input, for whom. */
export interface RunRequest {
  app: AppId;
  workflow: WorkflowId;
  input: Json | undefined;
  /**
   * The person who started it, whom it acts for; null for a trigger, and
   * the run acts for the App's owner (decision Q10).
   */
  startedBy: string | null;
  /** Who started it, for the audit log. */
  actor: AuditActor;
  /**
   * Where the person started it, when not directly: from one of the App's
   * screens (`screen`). The audit log says so (`via`).
   */
  via?: "screen";
  /**
   * The trigger that started it, with the key of what it started it for
   * (triggers.ts): while a run has that key, it is the run, and no other
   * starts. `version` is the App version that registered it: it starts a
   * run only of that version, while it is current.
   */
  trigger?: { type: TriggerType; key: string; version: number };
  /**
   * The run that started it, for a run another run starts: core's own,
   * from the engine's record of that run, never from anything an App or a
   * run's code passes in. The new run joins its lineage (`root_run_id`),
   * whose model calls and spend are counted together.
   */
  parent?: RunId;
}

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
 * it, so the run is started once however often this runs.
 */
const resendStart = async (env: Env, row: RunRow): Promise<void> => {
  if (row.pendingStart === null || row.status !== "starting") {
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
  no_instance: "The engine has no record of this run.",
} as const;

/**
 * Marks a run whose start the engine never confirmed as failed, for
 * `reason`, audited and notified as a failed run (`failureRecorded`),
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
      })
      .where(
        and(eq(workflowRuns.id, row.id), eq(workflowRuns.status, "starting"))
      )
      .returning({ id: workflowRuns.id }),
    ...(await failureRecorded(
      env,
      db,
      row,
      { reason, error: "workflow.run_failed" },
      sql`EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${workflowRuns.id} = ${row.id} AND ${workflowRuns.status} = 'failed')`
    )),
    // A start that reached the engine late may have run steps whose App
    // calls kept statistics points before this write ended the run, failed
    // or cancelled: forgotten with its end, as no notification after it
    // finds the run unended to forget them.
    stepStatisticsForgotten(
      db,
      row.id,
      sql`EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${workflowRuns.id} = ${row.id} AND ${workflowRuns.endedAt} IS NOT NULL)`
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
  await tellScreens(env, row);
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
 * Most starts one repair sends again: a budget for one cron run. Each one
 * the engine confirms leaves the set, so the next cron run takes the next.
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
 * Sends `row`'s start again (`repairStarts`). A start the engine still
 * won't take `repairGivesUpAfterMs` after it was written is marked failed,
 * but only once the engine says it has no record of the run: one it has
 * is confirmed, and one it can't say of is tried again by the next repair,
 * so a start whose answer was lost is never given up while it runs.
 */
const repairStart = async (env: Env, row: RunRow): Promise<void> => {
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
 * Each cron run takes at most `repairsPerRun` of them, in ID order from a
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
  // next cron run, and holds up none of the others.
  await Promise.all(
    rows.map(async (row) => {
      await repairStart(env, row);
    })
  );
};

/**
 * The root of the lineage a run started by `parent` joins: the parent's
 * own root, or the parent itself when it is a root. Read from the parent's
 * row, so a lineage holds however deep its runs nest.
 */
const rootOf = async (env: Env, parent: RunId): Promise<string> => {
  const row = await findRun(env, parent);
  if (row === undefined) {
    throw new Error(`No run ${parent} to start a run under`);
  }
  return row.rootRunId ?? row.id;
};

/**
 * The run a trigger's key `key` already started, its start sent again
 * while the engine is still to confirm it: the engine takes it as the
 * start it has, so a key delivered twice is one run.
 */
const deliveredBefore = async (
  env: Env,
  key: string,
  run: string
): Promise<WorkflowRun> => {
  const started = await drizzle(env.DB)
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.triggerKey, key))
    .get();
  if (!started) {
    throw new Error(`No run has the trigger key of run ${run}`);
  }
  await resendStart(env, started);
  return toRun(env, started);
};

/**
 * What a start whose call to the engine failed with `error` leaves
 * (`startRun`): returns when the engine has the run after all, and throws
 * `error` otherwise.
 */
const startFailed = async (
  env: Env,
  row: Pick<RunRow, "id" | "appId" | "workflowId" | "version" | "startedBy">,
  error: unknown
): Promise<void> => {
  log.error("workflow.start_failed", {
    runId: row.id,
    ...errorFields(error),
  });
  // An error is no proof the engine didn't take the start: its answer
  // may have been lost. Releasing the trigger key on such a start could
  // start a second run beside it, so the engine is asked first.
  const has = await engineHas(env, row.id);
  if (has === null) {
    // It can't say: the start stays pending, its key held, and the
    // repair sends it again under the same key, which the engine takes
    // once (`repairStarts`). A trigger delivered again finds this run.
    throw error;
  }
  if (!has) {
    // Not taken. Its report says only that it didn't start: the
    // platform's error stays in the log. It gives up its trigger key,
    // so the delivery tried again (a schedule stays due, mail and
    // events are retried) starts the run as a new one. Should the start
    // still reach the engine after all, the run's ended row is its
    // tombstone: the dispatcher runs none of it.
    await failStart(env, row, "start_failed");
    throw error;
  }
};

/**
 * Starts a run on the App's current version, which it keeps until it ends.
 * The row, the start it is to send and its audit event are written before
 * the start is sent, so the dispatcher always finds the row, and a start
 * core stops in the middle of is sent again (`repairStarts`). The row says
 * `starting` until the engine's first notification; a start that failed,
 * and that the engine then says it has no record of, is marked failed,
 * audited as a failed run (one it can't say of stays pending, for the
 * repair). A trigger's key
 * already taken returns the run that took it, whatever became of it
 * since, its start sent again while the engine is still to confirm it (a
 * start sent twice is one run); a run whose start failed gives its key up,
 * so the delivery tried again starts it anew. A trigger of a
 * version that is no longer current starts nothing
 * (`workflow.trigger_gone`): the version that replaced it may not declare
 * it. The run is pinned to the version checked, so at worst a trigger
 * starts its own version's run as that version is being replaced, as a
 * person starting it by hand then would. Input over
 * {@link maxInputLength} is refused (`workflow.invalid`), whoever starts it.
 */
export const startRun = async (
  env: Env,
  { app, workflow, input, startedBy, actor, via, trigger, parent }: RunRequest
): Promise<WorkflowRun> => {
  if (input !== undefined && JSON.stringify(input).length > maxInputLength) {
    throw invalid();
  }
  const db = drizzle(env.DB);
  const rootRunId = parent === undefined ? null : await rootOf(env, parent);
  const { currentVersion: version } = await appRecord(env, app);
  if (version === null) {
    throw appErrors.create("app.not_running");
  }
  if (trigger && trigger.version !== version) {
    throw workflowErrors.create("workflow.trigger_gone");
  }
  if (!hasWorkflow(await versionFiles(env, app, version), workflow)) {
    throw workflowErrors.create("workflow.not_found", { workflow, version });
  }
  const row = {
    id: crypto.randomUUID(),
    appId: app,
    workflowId: workflow,
    version,
    startedBy,
    status: "starting",
    createdAt: new Date(),
    endedAt: null,
    failure: null,
    triggerKey: trigger?.key ?? null,
    detailsRemovedAt: null,
    rootRunId,
    pendingStart: input === undefined ? {} : { input },
  } satisfies RunFields & typeof workflowRuns.$inferInsert;
  // Nothing is written, audit event included, for a key a run has.
  const [inserted] = await auditedBatch(env, db, [
    db
      .insert(workflowRuns)
      .values(row)
      .onConflictDoNothing({ target: workflowRuns.triggerKey })
      .returning({ id: workflowRuns.id }),
    outboxedIfChanged(
      db,
      runEntry(actor, "workflow.run.started", row, {
        startedBy: startedBy === null ? "trigger" : "person",
        ...(via === undefined ? {} : { via }),
        // The key names what started it: a time, a hash, an ID; never
        // what a message or event says.
        ...(trigger ? { trigger: trigger.type, key: trigger.key } : {}),
        // The lineage it joins, for a run another run started.
        ...(parent === undefined || rootRunId === null
          ? {}
          : { parent, root: rootRunId }),
      })
    ),
  ]);
  if (inserted.length === 0) {
    return await deliveredBefore(env, row.triggerKey ?? "", row.id);
  }
  try {
    await sendStart(env, row, input);
  } catch (error) {
    await startFailed(env, row, error);
  }
  await confirmStart(env, row.id);
  // Only now: a screen told of the run reads it from the engine too.
  await tellScreens(env, row);
  return toRun(env, row);
};

/**
 * Starts a run of an App's workflow for the person `by`; `via` says where,
 * when not directly (`RunRequest`).
 */
export const startWorkflow = async (
  env: Env,
  by: Identity,
  app: unknown,
  workflow: unknown,
  input?: unknown,
  via?: "screen"
): Promise<WorkflowRun> => {
  await appFor(env, by, app, "user");
  return await startRun(env, {
    app: parse(appIdSchema, app),
    workflow: parse(workflowInputSchema, workflow),
    input: parse(z.json().optional(), input),
    startedBy: by.userId,
    actor: actorOf(by),
    ...(via === undefined ? {} : { via }),
  });
};

/** Where the engine says a run is, as a run's status. */
const liveStatuses: Record<InstanceStatus["status"], RunStatus> = {
  queued: "running",
  running: "running",
  waitingForPause: "running",
  rollingBack: "running",
  waiting: "waiting",
  paused: "paused",
  errored: "failed",
  terminated: "cancelled",
  complete: "completed",
};

const foundRun = async (env: Env, run: unknown): Promise<RunRow> => {
  const row = await findRun(env, parse(runIdSchema, run));
  if (!row) {
    throw workflowErrors.create("workflow.run_not_found");
  }
  return row;
};

/**
 * A run, with its failure report when `by` sees its details. Once its
 * details are removed (retention.ts) the report's message says so, and
 * how long the deployment keeps them now, and its step is named without
 * its key: as the sweep leaves the row, whether it has reached it or not.
 */
export const runFor = (
  env: Env,
  by: Member,
  row: RunRow,
  ownerId: string
): WorkflowRun => {
  const run = toRun(env, row);
  if (row.failure === null || !seesDetails(by, row, ownerId)) {
    return run;
  }
  if (!run.detailsRemoved) {
    return { ...run, failure: row.failure };
  }
  const { step, error } = row.failure;
  return {
    ...run,
    failure: {
      ...row.failure,
      step: step === null ? null : (step.split(":", 1)[0] ?? step),
      error: { ...error, message: removedText(env) },
    },
  };
};

/**
 * Where the engine has a run; nothing for one still starting, or that
 * has ended without an instance to ask (its start failed, or the engine
 * removed its record, its retention over), whose row says all there is.
 */
const liveOf = async (
  env: Env,
  row: RunRow
): Promise<InstanceStatus | undefined> => {
  const live = await runEngine(env).status(row.id);
  if (
    live === undefined &&
    (row.status === "running" || row.status === "paused")
  ) {
    throw new Error(`The engine has no instance of run ${row.id}`);
  }
  return live;
};

/**
 * A run as it is now: where the engine has it while core last saw it
 * running. What it returned or why it failed can hold what the run read
 * for its person, so only they and admins see it (`seesDetails`).
 */
export const runStatus = async (
  env: Env,
  by: Member,
  run: unknown
): Promise<WorkflowRun> => {
  const row = await foundRun(env, run);
  const { owner: ownerId } = await appFor(env, by, row.appId, "user");
  const live = await liveOf(env, row);
  const status =
    (row.status === "starting" || row.status === "running") && live
      ? liveStatuses[live.status]
      : shownStatus(row.status);
  const found = { ...runFor(env, by, row, ownerId), status };
  // Once its details are removed, nothing the engine may still have of it
  // is shown: the list, the overview and screens show none either.
  if (found.detailsRemoved || !(live && seesDetails(by, row, ownerId))) {
    return found;
  }
  if (live.status === "complete") {
    const output = z.json().safeParse(live.output);
    return output.success ? { ...found, output: output.data } : found;
  }
  if (live.status === "errored") {
    const { name, message } = live.error;
    return { ...found, error: { name, message } };
  }
  return found;
};

/** An App's runs, newest first; `app.not_found` for an App there isn't. */
export const listRuns = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<WorkflowRun[]> => {
  const appId = parse(appIdSchema, app);
  const { owner: ownerId } = await appFor(env, by, appId, "user");
  const rows = await drizzle(env.DB)
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.appId, appId))
    .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
    .limit(runsPerPage);
  return rows.map((row) => runFor(env, by, row, ownerId));
};

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
    .set({ failure })
    .where(and(eq(workflowRuns.id, row.id), isNull(workflowRuns.failure)));
};

/** The engine's statuses of a run that has ended. */
const endedLive: ReadonlySet<InstanceStatus["status"]> = new Set([
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
}

/**
 * Makes the run's row say where the engine says it is: the one writer of
 * a run's status. A notification no newer than the last the row took is
 * late and changes nothing; an ended run's row never changes again. The
 * first one confirms the run's start, which nothing sends again. A run's
 * end is audited with its row, once: completed; failed, with its report
 * (its own, or one saying it stopped) and its owner notified; cancelled,
 * which a cancel has audited already, unless the engine ended it without
 * one. Screens are told of every change of status, and a run that ended
 * forgets the statistics points of its steps that never completed.
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
  // A cancelled run the engine ended otherwise than by terminating it
  // ended for its cancel: its next activation refused to run on. Whether
  // a cancel was asked for is decided in the write, as the row is then:
  // a cancel written since `row` was read makes it cancelled, not failed.
  const errored = engine.status === "errored";
  const status =
    row.cancelRequestedAt !== null && errored
      ? "cancelled"
      : projected[engine.status];
  const at = new Date(engine.at);
  const db = drizzle(env.DB);
  const fenced = and(
    eq(workflowRuns.id, row.id),
    inArray(workflowRuns.status, unended),
    engine.sequence === undefined
      ? undefined
      : lt(workflowRuns.engineSequence, engine.sequence)
  );
  const sequence =
    engine.sequence === undefined ? {} : { engineSequence: engine.sequence };
  const ended = endedLive.has(engine.status);
  const report = errored ? (row.failure ?? stoppedReport(row, at)) : null;
  const endedFailed = sql`EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${workflowRuns.id} = ${row.id} AND ${workflowRuns.status} = 'failed')`;
  const [[changed]] = await auditedBatch(env, db, [
    db
      .update(workflowRuns)
      .set({
        ...(report === null
          ? { status }
          : {
              status: sql`CASE WHEN ${workflowRuns.cancelRequestedAt} IS NULL THEN 'failed' ELSE 'cancelled' END`,
              failure: sql`CASE WHEN ${workflowRuns.cancelRequestedAt} IS NULL THEN ${JSON.stringify(report)} ELSE ${workflowRuns.failure} END`,
            }),
        pendingStart: null,
        ...sequence,
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
      : await failureRecorded(
          env,
          db,
          row,
          { error: report.error.code },
          endedFailed
        )),
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
    // Its end and the cleanup of the statistics points its steps never
    // added up are written together: a retried notification finds the
    // row ended, so nothing would be left to clean up after it.
    ...(ended ? [stepStatisticsForgotten(db, row.id)] : []),
  ]);
  if (!changed) {
    return;
  }
  if (shownStatus(row.status) !== changed.status) {
    await tellScreens(env, row);
  }
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
      .set({ cancelRequestedAt: new Date(mark.at), pendingStart: null })
      .where(
        and(
          eq(workflowRuns.id, row.id),
          inArray(workflowRuns.status, unended),
          isNull(workflowRuns.cancelRequestedAt)
        )
      ),
    outboxedIfChanged(db, runEntry(mark.actor, "workflow.run.cancelled", row)),
  ]);
};

/**
 * Stops a run for good, and records who did; a run that ended otherwise
 * stays as it is. Its tombstone is written first, with the audit event,
 * so the dispatcher runs nothing more of it whatever the engine still
 * does; then the engine is told to terminate it, and once it says it has
 * (or has no run to terminate: one whose start never reached it), the row
 * says so. A cancel whose termination failed is done again by cancelling
 * again. A run that ended on its own before the engine heard the cancel
 * stays as it ended.
 */
export const cancelRun = async (
  env: Env,
  by: Identity,
  run: unknown
): Promise<WorkflowRun> => {
  const row = await foundRun(env, run);
  await appFor(env, by, row.appId, "builder");
  if (!unended.includes(row.status)) {
    return toRun(env, row);
  }
  // First, in the run's object, the cancel's record: from then on no
  // attempt of it holds, so nothing more of it is handed back or acts,
  // even should the rest of this never happen. With it, the App calls its
  // attempts started are revoked in those Apps (run-object.ts,
  // `revokeCalls`). Should the mark fail, nothing of the cancel happened.
  // Should an App not hear of the revoke, the cancel goes on, and the
  // object revokes again on its alarm; should anything after the mark
  // fail, the object finishes the cancel. A run cancelled before keeps
  // its first cancel.
  const mark = await markRunCancelled(env, row.id, actorOf(by));
  await completeCancel(env, mark);
  const engine = runEngine(env);
  await engine.terminate(row.id);
  await settleRunCancel(env, row.id);
  const live = await engine.status(row.id);
  if (live === undefined || endedLive.has(live.status)) {
    await projectStatus(env, row.id, {
      status: live?.status ?? "terminated",
      at: Date.now(),
    });
  }
  return toRun(env, await foundRun(env, row.id));
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
const triggeredRunsPerHour = 60;

const hourMs = 60 * 60 * 1000;

/**
 * Where a message or event stands for a workflow it would start a run of:
 * `capped` while the workflow is at its hourly limit, `started` when the
 * workflow has its run already, its start confirmed, and `new` otherwise.
 */
export type DeliveryRoom = "capped" | "started" | "new";

/**
 * Where the message or event whose run has trigger key `key` stands for
 * App `app`'s workflow `workflow`. It is `capped` when triggers of `type`
 * started `triggeredRunsPerHour` of the workflow's runs in the past hour
 * (counted on its index by App, workflow and time), and none of them is
 * this one's. A workflow that has this one's run already is never capped
 * for it, so a delivery tried again because another workflow was capped
 * isn't refused by the run it started itself: it is `started` once the
 * engine has confirmed that run's start, and `new` while it hasn't, as the
 * delivery goes on to send the start again (`startRun`). Checked before the
 * starts, not with them, so what's delivered at the same moment can go a
 * few over.
 */
export const deliveryRoom = async (
  env: Env,
  app: string,
  workflow: string,
  key: string,
  type: "email" | "event"
): Promise<DeliveryRoom> => {
  const recent = and(
    gte(workflowRuns.createdAt, new Date(Date.now() - hourMs)),
    like(workflowRuns.triggerKey, `${type}:%`)
  );
  const mine = eq(workflowRuns.triggerKey, key);
  const past = and(mine, isNull(workflowRuns.pendingStart));
  const counted = await drizzle(env.DB)
    .select({
      runs: sql<number | null>`sum(case when ${recent} then 1 else 0 end)`,
      delivered: sql<number | null>`max(case when ${mine} then 1 else 0 end)`,
      started: sql<number | null>`max(case when ${past} then 1 else 0 end)`,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.appId, app),
        eq(workflowRuns.workflowId, workflow),
        or(recent, mine)
      )
    )
    .get();
  if (counted?.started === 1) {
    return "started";
  }
  return counted?.delivered !== 1 &&
    (counted?.runs ?? 0) >= triggeredRunsPerHour
    ? "capped"
    : "new";
};
