import { actorOf, createAuditEvent } from "@grasp-os/shared/audit";
import { runIdSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type { RunControl, WorkflowRun } from "@grasp-os/shared/workflows";
import type { InstanceStatus } from "@grasp-os/workerflow/contracts";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { appFor } from "../apps.ts";
import { auditedBatch, outboxedEventWhere } from "../audit-outbox.ts";
import { workflowRunControls, workflowRuns } from "../db/core/schema.ts";
import { markRunCancelled, runEngine, settleRunCancel } from "./engine.ts";
import {
  endedLive,
  findRun,
  projectStatus,
  runEntry,
  toRun,
  unended,
} from "./runs.ts";
import type { RunRow } from "./runs.ts";

// Pausing, resuming and cancelling a run, as the host admits each: one
// writer of the run's lifecycle still, the engine, told by core only what
// core admitted. Each request gets a durable receipt (`workflow_run_controls`)
// in the write that admits it, with its audit event, before anything is
// sent to the engine; the receipt settles once the engine confirms it
// (`applied`), here or in the run's status projection (runs.ts), or when a
// cancel supersedes it (`superseded`).
//
// - The same request again, while its receipt is unresolved, joins that
//   receipt (and sends it to the engine again, which takes it once): a
//   caller whose answer was lost recovers it rather than asking anew.
// - A request the run is already past (pausing a paused run, resuming a
//   running one, cancelling a cancelled one) is acknowledged with a receipt
//   that is applied at once.
// - Cancel has priority. It supersedes a pause or resume still unresolved,
//   writes the run's tombstone (the dispatcher runs nothing more of it),
//   and takes the next control generation, so a pause or resume admitted
//   before it can no longer reach the engine: a control is sent only while
//   its generation is the run's. A pause or resume asked for while a cancel
//   is admitted, or while the other is unresolved, is refused as a
//   conflict; one the run's lifecycle doesn't allow (an ended run) is
//   refused outright. Nothing is waited for: the engine, which serializes
//   its own commands, has the last word, and terminate is final there, so
//   a late pause or resume finds nothing to act on even if it got through.
// - A paused run keeps its deadlines: time doesn't stop. Its resume asks
//   the engine to leave every sleep, wait and retry where it was, so one
//   that came due while it was paused is taken at once.
// - A receipt the engine hasn't confirmed is sent again by the repair
//   (`repairControls`): an answer lost on the way, or a pause the engine
//   ignored because the run was still queued.

type ControlRow = typeof workflowRunControls.$inferSelect;

export type ControlKind = RunControl["kind"];

const controlKindSchema = z.enum(["pause", "resume", "cancel"]);

/** A receipt as its callers see it. */
const toControl = ({ id, kind, state }: ControlRow): RunControl => ({
  id,
  kind,
  state,
});

/** What a control is audited as. */
const requestedAction = {
  pause: "workflow.run.pause_requested",
  resume: "workflow.run.resume_requested",
  cancel: "workflow.run.cancelled",
} as const satisfies Record<ControlKind, `workflow.run.${string}`>;

/** The run's receipts the engine is still to confirm. */
const unresolvedOf = async (env: Env, run: string): Promise<ControlRow[]> =>
  await drizzle(env.DB)
    .select()
    .from(workflowRunControls)
    .where(
      and(
        eq(workflowRunControls.runId, run),
        eq(workflowRunControls.state, "admitted")
      )
    );

/** What the host makes of a request for `kind` of the run as it is. */
type Admission =
  | { type: "admit" }
  | { type: "done" }
  | { type: "join"; control: ControlRow }
  | {
      type: "refused";
      code: "workflow.control_conflict" | "workflow.control_refused";
    };

/**
 * What the host makes of a request for `kind` of `row`, with the run's
 * receipts still unresolved and where the engine has the run now (`engine`,
 * nothing when it has no record of it yet). Whether a pause or resume is
 * one the run is already past is the engine's to say, not the row's, which
 * follows the engine's notifications and may lag behind it.
 */
const admissionOf = (
  row: RunRow,
  unresolved: readonly ControlRow[],
  kind: ControlKind,
  engine: InstanceStatus | undefined
): Admission => {
  const same = unresolved.find((control) => control.kind === kind);
  if (same !== undefined) {
    return { type: "join", control: same };
  }
  const live = unended.includes(row.status);
  if (kind === "cancel") {
    if (live) {
      return { type: "admit" };
    }
    return row.status === "cancelled"
      ? { type: "done" }
      : { type: "refused", code: "workflow.control_refused" };
  }
  if (!live) {
    return { type: "refused", code: "workflow.control_refused" };
  }
  const other = kind === "pause" ? "resume" : "pause";
  if (
    row.cancelRequestedAt !== null ||
    unresolved.some(
      (control) => control.kind === other || control.kind === "cancel"
    )
  ) {
    return { type: "refused", code: "workflow.control_conflict" };
  }
  // A run the engine has no record of yet is still starting: a pause of
  // it is admitted, and applies once it starts (`apply`); it has nothing
  // to resume.
  const paused =
    engine?.status === "paused" || engine?.status === "waitingForPause";
  const already = kind === "pause" ? engine?.status === "paused" : !paused;
  return already ? { type: "done" } : { type: "admit" };
};

/**
 * Writes the receipt `id` for `kind` of `row`, with its audit event, in
 * one batch: admitted, under the run's next control generation, only if
 * nobody admitted anything for the run since `row` was read; or, for a
 * request the run is past (`done`), applied at once, under the current
 * one. A cancel writes the run's tombstone and supersedes the pause or
 * resume still unresolved. Whether it was written.
 */
const writeReceipt = async (
  env: Env,
  by: Identity,
  row: RunRow,
  kind: ControlKind,
  done: boolean,
  via?: "screen",
  cancelledAt?: number
): Promise<string | undefined> => {
  const db = drizzle(env.DB);
  const id = crypto.randomUUID();
  const now = Date.now();
  const cancelling = kind === "cancel" && !done;
  const generation = done ? row.controlGeneration : row.controlGeneration + 1;
  const written = sql`EXISTS (SELECT 1 FROM ${workflowRunControls} WHERE ${workflowRunControls.id} = ${id})`;
  const event = createAuditEvent(
    runEntry(actorOf(by), requestedAction[kind], row, {
      control: id,
      ...(done ? { already: true } : {}),
      ...(via === undefined ? {} : { via }),
    }),
    "core"
  );
  const admits = and(
    eq(workflowRuns.id, row.id),
    eq(workflowRuns.controlGeneration, row.controlGeneration),
    // An acknowledgement may be of an ended run (a cancelled run
    // cancelled again); nothing else is admitted once it has ended.
    done ? undefined : inArray(workflowRuns.status, unended)
  );
  const update = db
    .update(workflowRuns)
    .set({
      controlGeneration: generation,
      ...(cancelling
        ? {
            cancelRequestedAt: sql`COALESCE(${workflowRuns.cancelRequestedAt}, ${cancelledAt ?? now})`,
            pendingStart: null,
          }
        : {}),
    })
    .where(admits);
  const receipt = db
    .insert(workflowRunControls)
    .select(
      sql`SELECT ${id}, ${row.id}, ${kind}, ${done ? "applied" : "admitted"}, ${generation}, ${by.userId}, ${now}, ${done ? now : null} WHERE changes() > 0`
    );
  await (cancelling
    ? auditedBatch(env, db, [
        // A cancel is audited once, by whichever writes its tombstone
        // first: this receipt, or the run object's repair of a cancel
        // whose request didn't (runs.ts, `completeCancel`). So before this
        // write, while the run has none.
        outboxedEventWhere(
          db,
          event,
          sql`EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${and(admits, isNull(workflowRuns.cancelRequestedAt))})`
        ),
        update,
        receipt,
        db
          .update(workflowRunControls)
          .set({ state: "superseded", settledAt: new Date(now) })
          .where(
            and(
              eq(workflowRunControls.runId, row.id),
              eq(workflowRunControls.state, "admitted"),
              inArray(workflowRunControls.kind, ["pause", "resume"]),
              lt(workflowRunControls.generation, generation),
              written
            )
          ),
      ])
    : auditedBatch(env, db, [
        update,
        receipt,
        outboxedEventWhere(db, event, written),
      ]));
  const found = await db
    .select({ id: workflowRunControls.id })
    .from(workflowRunControls)
    .where(eq(workflowRunControls.id, id))
    .get();
  return found?.id;
};

/** Settles the receipt `id`, if it is still unresolved. */
const settle = async (
  env: Env,
  id: string,
  state: "applied" | "superseded"
): Promise<void> => {
  await drizzle(env.DB)
    .update(workflowRunControls)
    .set({ state, settledAt: new Date() })
    .where(
      and(
        eq(workflowRunControls.id, id),
        eq(workflowRunControls.state, "admitted")
      )
    );
};

/** Whether the engine's `live` status is what a control of `kind` asked. */
const holdsFor = (kind: ControlKind, live: InstanceStatus): boolean =>
  kind === "pause"
    ? live.status === "paused"
    : kind === "resume" &&
      live.status !== "paused" &&
      live.status !== "waitingForPause";

/**
 * Sends an admitted receipt to the engine, unless a newer control
 * superseded it (its generation is no longer the run's), and settles it
 * as soon as the engine says it holds: paused, no longer paused, or ended.
 * A cancel whose engine run has ended (or never existed) brings the run's
 * row to its end now (runs.ts, `projectStatus`).
 */
const apply = async (env: Env, control: ControlRow): Promise<void> => {
  if (control.state !== "admitted") {
    return;
  }
  const row = await findRun(env, runIdSchema.parse(control.runId));
  if (row === undefined) {
    return;
  }
  // A pause or resume a newer control overtook, or of a run that has
  // ended (its start failed, say), has nothing left to apply to.
  if (
    control.kind !== "cancel" &&
    (control.generation !== row.controlGeneration ||
      !unended.includes(row.status))
  ) {
    await settle(env, control.id, "superseded");
    return;
  }
  const engine = runEngine(env);
  if (control.kind === "cancel") {
    await engine.terminate(row.id);
    await settleRunCancel(env, row.id);
  } else {
    // A run the engine has no record of yet hasn't started: nothing to
    // pause or resume, and nothing ended either. The receipt stays
    // admitted, and the repair sends it again once the run has started.
    // Only a cancel ends a run the engine has no record of.
    if ((await engine.status(row.id)) === undefined) {
      return;
    }
    await (control.kind === "pause"
      ? engine.pause(row.id)
      : engine.resume(row.id));
  }
  const live = await engine.status(row.id);
  if (live === undefined && control.kind !== "cancel") {
    return;
  }
  if (live === undefined || endedLive.has(live.status)) {
    // Ended: whatever was asked, the run is past it. Its row says so, and
    // the receipt settles with it: a cancel as done once the run ended
    // cancelled, anything else as overtaken by the end.
    await projectStatus(env, row.id, {
      status: live?.status ?? "terminated",
      at: Date.now(),
    });
    const ended = await findRun(env, runIdSchema.parse(row.id));
    await settle(
      env,
      control.id,
      control.kind === "cancel" && ended?.status === "cancelled"
        ? "applied"
        : "superseded"
    );
    return;
  }
  if (holdsFor(control.kind, live)) {
    await settle(env, control.id, "applied");
  }
};

/**
 * Settles the run's unresolved pause and resume as `live`, where the
 * engine has the run as it is read now, says: each only from such a
 * read, never from a notification, which may be older than the receipt
 * (a late "paused" says nothing of a pause asked for after it). Asked by
 * the run's object as it hands on its status changes (run-object.ts).
 */
export const settleControls = async (
  env: Env,
  run: string,
  live: InstanceStatus | undefined
): Promise<void> => {
  if (live === undefined) {
    return;
  }
  const unresolved = await unresolvedOf(env, run);
  await Promise.all(
    unresolved
      .filter(({ kind }) => kind !== "cancel" && holdsFor(kind, live))
      .map(async ({ id }) => {
        await settle(env, id, "applied");
      })
  );
};

/**
 * Admits `kind` of `row` for `by` (who may: the caller checked), or joins
 * the receipt of the same request still unresolved, sends it to the
 * engine, and answers its receipt as it stands then. Refused with
 * `workflow.control_conflict` or `workflow.control_refused`, as above.
 */
const control = async (
  env: Env,
  by: Identity,
  run: RunRow,
  kind: ControlKind,
  via?: "screen"
): Promise<RunControl> => {
  let row = run;
  // Once more each time another request was admitted for the run between
  // reading it and writing: the next read sees it.
  for (let tries = 0; tries < 5; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- read again after a race
    const unresolved = await unresolvedOf(env, row.id);
    const live =
      kind === "cancel"
        ? undefined
        : // oxlint-disable-next-line no-await-in-loop -- read again after a race
          await runEngine(env).status(row.id);
    const admission = admissionOf(row, unresolved, kind, live);
    if (admission.type === "refused") {
      throw workflowErrors.create(admission.code);
    }
    let id: string | undefined;
    let cancelledAt: number | undefined;
    if (admission.type === "join") {
      ({ id } = admission.control);
    } else {
      if (kind === "cancel" && admission.type === "admit") {
        // First, in the run's object, the cancel's record: from then on
        // no attempt of it holds, so nothing more of it is handed back or
        // acts, even should the engine never terminate it. Should this
        // fail, nothing of the cancel happened; should what follows fail,
        // the object finishes it (run-object.ts). A run cancelled before
        // keeps its first cancel's time.
        // oxlint-disable-next-line no-await-in-loop -- once, before the receipt
        ({ at: cancelledAt } = await markRunCancelled(
          env,
          row.id,
          actorOf(by)
        ));
      }
      // oxlint-disable-next-line no-await-in-loop -- read again after a race
      id = await writeReceipt(
        env,
        by,
        row,
        kind,
        admission.type === "done",
        via,
        cancelledAt
      );
    }
    if (id !== undefined) {
      const db = drizzle(env.DB);
      // oxlint-disable-next-line no-await-in-loop -- once, then answered
      const written = await db
        .select()
        .from(workflowRunControls)
        .where(eq(workflowRunControls.id, id))
        .get();
      if (written !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- once, then answered
        await apply(env, written);
        // oxlint-disable-next-line no-await-in-loop -- once, then answered
        const now = await db
          .select()
          .from(workflowRunControls)
          .where(eq(workflowRunControls.id, id))
          .get();
        return toControl(now ?? written);
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- read again after a race
    const again = await findRun(env, runIdSchema.parse(row.id));
    if (again === undefined) {
      throw workflowErrors.create("workflow.run_not_found");
    }
    row = again;
  }
  throw workflowErrors.create("workflow.control_conflict");
};

/** The run `run` names, or `workflow.run_not_found`. */
const foundRun = async (env: Env, run: unknown): Promise<RunRow> => {
  const id = runIdSchema.safeParse(run);
  const row = id.success ? await findRun(env, id.data) : undefined;
  if (row === undefined) {
    throw workflowErrors.create("workflow.run_not_found");
  }
  return row;
};

/**
 * Cancels a run for a builder of its App (the Workflows API), and answers
 * the run as its row says once the engine has heard: `cancelled` once the
 * engine confirmed the end, as it does for a run it terminates.
 */
export const cancelRun = async (
  env: Env,
  by: Identity,
  run: unknown
): Promise<WorkflowRun> => {
  const row = await foundRun(env, run);
  await appFor(env, by, row.appId, "builder");
  if (unended.includes(row.status)) {
    await control(env, by, row, "cancel");
  }
  return toRun(env, await foundRun(env, row.id));
};

/**
 * Pauses, resumes or cancels a run of `app` from one of its screens, for a
 * builder of the App: the role the Workflows API asks of whoever cancels a
 * run, and nobody else. A run of another App is `workflow.run_not_found`.
 * Audited as asked on a screen (`via: "screen"`).
 */
export const controlScreenRun = async (
  env: Env,
  by: Identity,
  app: unknown,
  run: unknown,
  kind: unknown
): Promise<RunControl> => {
  const asked = controlKindSchema.safeParse(kind);
  if (!asked.success) {
    throw workflowErrors.create("workflow.invalid");
  }
  const { id } = await appFor(env, by, app, "builder");
  const row = await foundRun(env, run);
  if (row.appId !== id) {
    throw workflowErrors.create("workflow.run_not_found");
  }
  return await control(env, by, row, asked.data, "screen");
};

/** How long a receipt is left to the request that admitted it. */
const repairAfterMs = 30_000;

/** Most receipts one repair sends again. */
const repairsPerRun = 50;

/**
 * Sends again each receipt the engine hasn't confirmed `repairAfterMs`
 * after it was admitted, oldest first, at most `repairsPerRun` a run: one
 * whose answer was lost on the way, or a pause the engine ignored while
 * the run was still queued. Each on its own: one that fails is tried
 * again by the next repair.
 */
export const repairControls = async (env: Env): Promise<void> => {
  const db = drizzle(env.DB);
  // First, in one statement: a pause or resume of a run that has ended
  // has nothing to apply to, so receipts the engine can no longer
  // confirm never fill the repair's budget.
  await db
    .update(workflowRunControls)
    .set({ state: "superseded", settledAt: new Date() })
    .where(
      and(
        eq(workflowRunControls.state, "admitted"),
        inArray(workflowRunControls.kind, ["pause", "resume"]),
        sql`EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${workflowRuns.id} = ${workflowRunControls.runId} AND ${workflowRuns.endedAt} IS NOT NULL)`
      )
    );
  const due = await db
    .select()
    .from(workflowRunControls)
    .where(
      and(
        eq(workflowRunControls.state, "admitted"),
        lt(workflowRunControls.createdAt, new Date(Date.now() - repairAfterMs)),
        isNull(workflowRunControls.settledAt)
      )
    )
    .orderBy(asc(workflowRunControls.createdAt), asc(workflowRunControls.id))
    .limit(repairsPerRun);
  await Promise.all(
    due.map(async (receipt) => {
      try {
        await apply(env, receipt);
      } catch (error) {
        log.error("workflow.control_repair_failed", {
          runId: receipt.runId,
          control: receipt.id,
          ...errorFields(error),
        });
      }
    })
  );
};
