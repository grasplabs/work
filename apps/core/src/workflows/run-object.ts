import type { AuditActor } from "@grasp-os/shared/audit";
import { errorFields, log } from "@grasp-os/shared/log";
import type {
  DefinitionIdentity,
  WorkflowDefinition,
  WorkflowError,
} from "@grasp-os/workerflow/contracts";
import { WorkflowRun } from "@grasp-os/workerflow/run";
import type { RunNotification } from "@grasp-os/workerflow/run";
import { z } from "zod";

import { loadWorkflowBuild } from "../workflow-builds.ts";
import { projectCandidateRun } from "./candidate-runs.ts";
import { runPinned } from "./dispatcher.ts";
import { pinOf } from "./engine.ts";
import type { PinnedResourceRun, RunPin } from "./engine.ts";
import { newAiCalls, waitKeyOf, waitStepPrefix } from "./host.ts";
import type { AiCalls } from "./host.ts";
import { sharesReleased } from "./quotas.ts";
import { projectResourceRun, settleResourceControls } from "./resource-runs.ts";
import type { EngineStatus } from "./runs.ts";
import type { StepError } from "./sealed-isolate.ts";
import type { RunModelCalls, SentCalls } from "./sealed-run.ts";
import { sealedStepOf, sealedStepsOf } from "./sealed-steps.ts";

/**
 * The key of the task step a step of core's own is a round or a wait of
 * (`$grasp:wait:<key>:…`, host.ts, `waitKeyOf` of the task step's name);
 * none for any other step.
 */
const coreRoundKey = new RegExp(
  `^${waitStepPrefix.replaceAll("$", "\\$")}(?<key>[0-9a-f]{16}):`,
  "u"
);

/**
 * The task step `name` is of: its own, by `tasks` (task steps by name), or,
 * for a round or a wait of core's own, the task of the step it is keyed by
 * (`waitKeyOf` of its name), followed through each such step it is a
 * round of in turn (a call held inside a retry's round): `steps` is every
 * step's name of the journal. None for a step of no task.
 */
const taskOfStep = async (
  name: string,
  tasks: ReadonlyMap<string, string>,
  steps: ReadonlySet<string>
): Promise<string | null> => {
  const byKey = new Map<string, string>();
  for (const step of steps) {
    // oxlint-disable-next-line no-await-in-loop -- a digest each
    byKey.set(await waitKeyOf(step), step);
  }
  let step: string | undefined = name;
  // Each step at most once: a key leads only to an earlier step.
  for (let hops = 0; step !== undefined && hops <= steps.size; hops += 1) {
    const task = tasks.get(step);
    if (task !== undefined) {
      return task;
    }
    const key: string | undefined = coreRoundKey.exec(step)?.groups?.key;
    step = key === undefined ? undefined : byKey.get(key);
  }
  return null;
};

/** The most records one page of the run's history holds (workerflow's). */
const historyPage = 500;

/** Whether the run's own table is there: a run removed keeps nothing. */
const runIsThere = (sql: SqlStorage): boolean =>
  sql
    .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run'")
    .toArray().length > 0;

/** A kept failure, as the host kept it: a step's error, or nothing. */
const keptFailureSchema = z.object({
  name: z.string(),
  message: z.string(),
  code: z.string().optional(),
});

/** A failure as `keptFailureSchema` keeps it, read back; none if unreadable. */
const keptFailureOf = (failure: string): StepError | undefined => {
  const kept = keptFailureSchema.safeParse(JSON.parse(failure)).data;
  return kept === undefined
    ? undefined
    : {
        name: kept.name,
        message: kept.message,
        ...(kept.code === undefined ? {} : { code: kept.code }),
      };
};

/**
 * Where a sealed build's run keeps the attempts of its steps that sent a
 * call tried once, and what each failed with (sealed-run.ts, `SentCalls`):
 * a table of its object's SQLite beside the engine's journal, dropped with
 * it by the engine's removal of the run. Only the host writes it, never the run's
 * code. Marked before the call goes out: the object's output gate holds
 * the call until the write is durable, so an activation that dies after
 * the call left, and every one after it, finds the mark.
 */
const sentCallsTable = "grasp_sent_calls";

/** One row of `sentCallsTable`, if the table and the row are there. */
const sentCallRow = (
  sql: SqlStorage,
  key: string,
  attempt: number
): { sent: number; failure: string | null } | undefined => {
  const there =
    sql
      .exec(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        sentCallsTable
      )
      .toArray().length > 0;
  if (!there) {
    return undefined;
  }
  const [row] = sql
    .exec<{ sent: number; failure: string | null }>(
      `SELECT sent, failure FROM ${sentCallsTable} WHERE key = ? AND attempt = ?`,
      key,
      attempt
    )
    .toArray();
  return row;
};

/** Writes an attempt's row of `sentCallsTable`, while the run is there. */
const writeSentCall = (
  sql: SqlStorage,
  key: string,
  attempt: number,
  values: { sent: 0 | 1 } | { failure: string }
): void => {
  if (!runIsThere(sql)) {
    return;
  }
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${sentCallsTable} (key TEXT NOT NULL, attempt INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0, failure TEXT, PRIMARY KEY (key, attempt))`
  );
  if ("sent" in values) {
    sql.exec(
      `INSERT INTO ${sentCallsTable} (key, attempt, sent) VALUES (?, ?, ?) ON CONFLICT (key, attempt) DO UPDATE SET sent = excluded.sent`,
      key,
      attempt,
      values.sent
    );
    return;
  }
  sql.exec(
    `INSERT INTO ${sentCallsTable} (key, attempt, failure) VALUES (?, ?, ?) ON CONFLICT (key, attempt) DO UPDATE SET failure = excluded.failure`,
    key,
    attempt,
    values.failure
  );
};

/** A sealed run's sent calls, kept with it (`sentCallsTable`). */
export const sentCallsIn = (sql: SqlStorage): SentCalls => ({
  markSent: (key, attempt) => {
    writeSentCall(sql, key, attempt, { sent: 1 });
  },
  unmarkSent: (key, attempt) => {
    writeSentCall(sql, key, attempt, { sent: 0 });
  },
  sent: (key, attempt) => sentCallRow(sql, key, attempt)?.sent === 1,
  keepFailure: (key, attempt, error) => {
    writeSentCall(sql, key, attempt, { failure: JSON.stringify(error) });
  },
  failureOf: (key, attempt) => {
    const failure = sentCallRow(sql, key, attempt)?.failure ?? null;
    return failure === null ? undefined : keptFailureOf(failure);
  },
});

/**
 * Where a run keeps the model calls it made (sealed-run.ts, `RunModelCalls`; GRA-700): a table of its object's
 * SQLite beside the engine's journal, dropped with it by the engine's
 * removal of the run. Only the host writes it, never the run's code. Written before the
 * call goes out: the object's output gate holds the call until the write
 * is durable, so a call made always counts.
 */
const modelCallsTable = "grasp_action_model_calls";

/** The model calls the run made, kept with it (`modelCallsTable`). */
export const modelCallsIn = (sql: SqlStorage): RunModelCalls => ({
  count: () => {
    const there =
      sql
        .exec(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
          modelCallsTable
        )
        .toArray().length > 0;
    if (!there) {
      return 0;
    }
    const [row] = sql
      .exec<{ made: number }>(`SELECT count(*) AS made FROM ${modelCallsTable}`)
      .toArray();
    return row?.made ?? 0;
  },
  keep: (key) => {
    if (!runIsThere(sql)) {
      return;
    }
    // A row each time, never merged: a call kept twice was made twice.
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${modelCallsTable} (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL)`
    );
    sql.exec(`INSERT INTO ${modelCallsTable} (key) VALUES (?)`, key);
  },
});

/**
 * Where a run's object keeps that the run was stopped (`markStopped`):
 * a table of its SQLite beside the engine's journal, which the engine's
 * removal of the run drops with it.
 */
const cancelTable = "grasp_run_cancelled";

/**
 * The newest generation of the run whose attempts' shares this object has
 * given back (`WorkflowRuns.#sharesReleased`): a table the engine drops
 * with the run, as `cancelTable`.
 */
const sharesTable = "grasp_run_shares";

/** What `sharesTable` holds: 0 before the object gave anything back. */
const releasedThrough = (sql: SqlStorage): number => {
  const known =
    sql
      .exec(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        sharesTable
      )
      .toArray().length > 0;
  if (!known) {
    return 0;
  }
  return (
    sql
      .exec<{ released: number }>(`SELECT released FROM ${sharesTable}`)
      .toArray()[0]?.released ?? 0
  );
};

/** How long a cancel's request has to finish it before the object does. */
const cancelRepairMs = 5000;

/** Whether the run in `sql` was marked stopped (`markStopped`). */
const cancelledIn = (sql: SqlStorage): boolean =>
  sql
    .exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      cancelTable
    )
    .toArray().length > 0;

/**
 * The stop a run is marked with (`markStopped`): whether the object has
 * terminated the run (`settled`), and when it next tries if it hasn't
 * (`due`).
 */
interface CancelMark {
  settled: boolean;
  due: number;
}

/** The stop kept in `sql`, if any (`markStopped`). */
const cancelMarkIn = (sql: SqlStorage): CancelMark | undefined => {
  if (!cancelledIn(sql)) {
    return undefined;
  }
  const [row] = sql
    .exec<{
      settled: number;
      due: number;
    }>(`SELECT settled, due FROM ${cancelTable} LIMIT 1`)
    .toArray();
  return row === undefined
    ? undefined
    : { settled: row.settled === 1, due: row.due };
};

/** Whether `mark` leaves the object something to do (`alarm`). */
const unfinished = (mark: CancelMark | undefined): mark is CancelMark =>
  mark !== undefined && !mark.settled;

// The object every workflow run lives in (`WORKFLOW_RUNS`): Workerflow's
// run object, one per run, which core reaches only through engine.ts. It
// is the only authority on a run's execution: its steps, waits, attempts
// and lifecycle. Core gives it one thing, the definition a run executes,
// resolved afresh on every activation from the version the run was
// created with (engine.ts, `pinOf`): the dispatcher loads the run's row,
// its authority and its code at the pinned version (dispatcher.ts).
//
// It tells core of each status a run takes, through its durable outbox, in
// order and at least once (`notify`): core's record of the run follows the
// engine, and only the engine (resource-runs.ts, `projectResourceRun`).
//
// No route reaches it: it is registered privately, its namespace bound to
// core alone.

export class WorkflowRuns extends WorkflowRun<Env> {
  /**
   * The run's AI calls, kept in memory across its activations (host.ts,
   * `AiCalls`): an activation that starts after another gave up on an
   * attempt finds the call that attempt still has out. Gone with the
   * object, as the call is.
   */
  readonly #aiCalls: AiCalls = newAiCalls();

  // The engine's abstract hook, which a subclass can only override as it
  // is declared. Only core holds this namespace, and a definition built
  // for a caller runs nothing: the engine runs a run's definition itself.
  // oxlint-disable-next-line grasp/no-unbounded-rpc-target -- see above
  protected definition(
    identity: DefinitionIdentity
  ): WorkflowDefinition | undefined {
    const pin = pinOf(identity);
    if (pin === undefined) {
      return undefined;
    }
    return {
      run: async (event, step) => {
        // The activation this execution runs in: an older one taken over
        // runs nothing more (`current`).
        const generation = this.generation();
        // Marked stopped: an activation that starts now (an event came,
        // a wait's alarm fired) runs nothing of the run, and finishes the
        // stop instead (`#finishCancel`).
        const mark = cancelMarkIn(this.ctx.storage.sql);
        if (mark !== undefined) {
          await this.#finishCancel(mark);
          return null;
        }
        return await runPinned(this.env, pin, event, step, {
          modelCalls: modelCallsIn(this.ctx.storage.sql),
          sentCalls: sentCallsIn(this.ctx.storage.sql),
          aiCalls: this.#aiCalls,
          leaseOf: (key, attempt) => this.#leaseOf(key, attempt),
          ...(this.#activation === undefined
            ? {}
            : { over: this.#activation.signal }),
          // Cancelled (its mark written), or taken over by a newer
          // activation: read from the object's own storage, no await.
          current: () =>
            !cancelledIn(this.ctx.storage.sql) &&
            this.generation() === generation,
          // The run's time, which only an App's test moves (`advanceClock`).
          now: () => this.runTime(),
          // Only a run an App's test started is ever restarted
          // (fixture-runs.ts).
          ...(pin.type === "fixture"
            ? {
                restart: async () => {
                  await this.restartActivation();
                },
              }
            : {}),
        });
      },
    };
  }

  /**
   * Marks the run stopped in its object (`markStopped`), with who stopped
   * it and when, kept with the run until the object terminated it. From
   * then on no attempt of the run holds (`#leaseOf`), so every fenced call
   * of it is refused at once, in this object, with no read of core's
   * database, whatever happens to the rest of the stop. A second stop
   * finds the first's mark. Should the stop's request not terminate the
   * run, the object does on its next alarm (`alarm`), which is armed
   * here.
   */
  async #markCancelled(
    runId: string,
    actor: AuditActor,
    at: number
  ): Promise<void> {
    const { sql } = this.ctx.storage;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${cancelTable} (run_id TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL)`
    );
    if (cancelMarkIn(sql) === undefined) {
      sql.exec(
        `INSERT INTO ${cancelTable} (run_id, actor, at, due) VALUES (?, ?, ?, ?)`,
        runId,
        JSON.stringify(actor),
        at,
        Date.now() + cancelRepairMs
      );
    }
    const mark = cancelMarkIn(sql);
    if (mark === undefined) {
      throw new Error(`Run ${runId}'s stop wasn't kept`);
    }
    // Armed for the stop's repair, should its request not finish it; the
    // engine's own alarms keep it (`extraAlarm`).
    await this.#armRepair(mark.due);
  }

  /**
   * Marks an independent workflow's run stopped by `actor` (resource-runs.ts,
   * `stopResourceRun`) (`#markCancelled`): from then on no attempt of it
   * holds, and should its request not terminate
   * it, the object does on its next alarm, seconds on. Unless the run is
   * rolling back, which a stop doesn't cut short (spec 10.7.3): then
   * nothing is marked. Decided and marked from the run's own journal with
   * no await between, so no rollback starts in between. `ended` for a run
   * that has ended, `missing` for one the engine has no journal of: neither
   * is marked.
   */
  async markStopped(
    runId: string,
    actor: AuditActor,
    at: number
  ): Promise<"marked" | "rolling_back" | "ended" | "missing"> {
    const live = this.status();
    if (live === undefined) {
      return "missing";
    }
    if (live.status === "rollingBack") {
      return "rolling_back";
    }
    if (
      live.status === "complete" ||
      live.status === "errored" ||
      live.status === "terminated"
    ) {
      return "ended";
    }
    await this.#markCancelled(runId, actor, at);
    return "marked";
  }

  /**
   * Finishes the stop `mark` records, as its request does: the run
   * terminated and the mark settled.
   */
  async #finishCancel(mark: CancelMark): Promise<void> {
    if (mark.settled) {
      return;
    }
    await this.terminate({ rollback: false });
    this.ctx.storage.sql.exec(`UPDATE ${cancelTable} SET settled = 1`);
  }

  /** Moves the cancel's next repair a while on, and arms it. */
  async #repairLater(): Promise<void> {
    const due = Date.now() + cancelRepairMs;
    this.ctx.storage.sql.exec(`UPDATE ${cancelTable} SET due = ?`, due);
    await this.#armRepair(due);
  }

  /** Brings the object's alarm forward to `due`, if it is later. */
  async #armRepair(due: number): Promise<void> {
    const armed = await this.ctx.storage.getAlarm();
    if (armed === null || armed > due) {
      await this.ctx.storage.setAlarm(due);
    }
  }

  /**
   * When the cancel the run is marked with next needs the object's alarm,
   * while any of it is left to do (`alarm`): kept whatever alarm the
   * engine sets or deletes for the run (a heartbeat, a sleep's wake, a
   * suspended run's none).
   */
  // oxlint-disable-next-line grasp/no-unbounded-rpc-target -- the engine's hook, as `definition`
  protected override extraAlarm(): number | null {
    const mark = cancelMarkIn(this.ctx.storage.sql);
    return unfinished(mark) ? mark.due : null;
  }

  /**
   * Moves the clock of a run an App's test started `ms` on (workerflow's
   * `advanceClock`, `t.clock.advance`). Refused for any other run: no
   * run of the organization's has its time moved. A run not created yet
   * (its test moved its clock before it started) is the test's to create
   * next, and starts at that time.
   */
  async advanceFixtureClock(ms: number): Promise<void> {
    await this.advanceClock(ms);
  }

  /**
   * Whether the run waits for something now, its wake not due (workerflow's
   * `waitsNow`): what an App's test waits for before moving its clock
   * past a sleep (`t.runs.untilWaiting`).
   */
  async fixtureWaits(): Promise<boolean> {
    return await this.waitsNow();
  }

  /**
   * The time now as the run measures it (workerflow's `runTime`): what an
   * App's test's answer to its decision is timed by (fixture-decisions.ts).
   */
  fixtureNow(): number {
    return this.runTime();
  }

  /**
   * Whether this is a run an App's test started, the only kind whose clock
   * moves or whose activation is restarted (workerflow's `testsRun`). One
   * not created yet is the test's to create next: its test moved its
   * clock before it started (engine.ts, `createFixture`), under an ID core
   * minted for it: an object that never held a run, never one whose run
   * was removed.
   */
  // oxlint-disable-next-line grasp/no-unbounded-rpc-target -- the engine's hook, as `definition`
  protected override testsRun(): boolean {
    const identity = this.runIdentity();
    return identity === undefined
      ? this.neverRan()
      : pinOf(identity)?.type === "fixture";
  }

  /**
   * Aborts once the alarm running the run's activation returns
   * (`RunMemory.over`): only an alarm runs one.
   */
  #activation: AbortController | undefined;

  /**
   * Finishes a stop its request didn't (`markStopped`), terminating the
   * run, then does what the engine's alarm does.
   */
  override async alarm(): Promise<void> {
    const mark = cancelMarkIn(this.ctx.storage.sql);
    if (unfinished(mark)) {
      try {
        await this.#finishCancel(mark);
      } catch (error) {
        // Tried again a while on (`extraAlarm`), whatever the engine does
        // with the alarm meanwhile.
        log.error("workflow.cancel_repair_failed", {
          runId: this.instanceId(),
          ...errorFields(error),
        });
        await this.#repairLater();
      }
    }
    // The engine runs a run's activations in its alarm alone: once it
    // returns, the activation it ran, if any, is over, its definition's
    // call settled or left to never settle (a wait suspended it).
    const activation = new AbortController();
    this.#activation = activation;
    try {
      await super.alarm();
    } finally {
      this.#activation = undefined;
      activation.abort(new Error("The run's activation is over."));
    }
  }

  /**
   * The engine's lease of an attempt (`attemptLease`), unless the run was
   * marked stopped (`markStopped`): then no attempt of it holds.
   */
  #leaseOf(key: string, attempt: number) {
    return cancelledIn(this.ctx.storage.sql)
      ? undefined
      : this.attemptLease(key, attempt);
  }

  /**
   * Takes the run's status changes: the newest of each batch is all core's
   * record needs, as a later status replaces an earlier one. A run of
   * core's own (an upload's extraction, a build), or one an App's test
   * started, has no row to follow it.
   * A failure is thrown, so the engine hands the batch over again.
   */
  // oxlint-disable-next-line grasp/no-unbounded-rpc-target -- the engine's hook, as `definition`
  protected override async notify(
    notifications: readonly RunNotification[]
  ): Promise<void> {
    const latest = notifications.at(-1);
    if (latest === undefined) {
      return;
    }
    const pin = pinOf({
      definition: latest.workflow,
      version: latest.version,
    });
    if (pin?.type === "resource" || pin?.type === "candidate") {
      await this.#independentNotified(pin, latest);
    }
  }

  /**
   * Takes the status of an independent workflow's run, or a test run of
   * its draft (`notify`): its row follows the engine's status; a page's
   * controls of an independent run settle from the engine's own word on
   * them, below.
   */
  async #independentNotified(
    pin: Extract<RunPin, { type: "resource" | "candidate" }>,
    latest: RunNotification
  ): Promise<void> {
    const { type } = pin;
    // Why it failed, from its own journal: kept on its row, so the code
    // outlives the engine's record of the run.
    const live = this.status();
    // A run marked stopped (`markStopped`) that fails before its
    // termination lands, its attempts refused from the stop on, ended
    // by the stop: cancelled, not failed. Unless
    // its journal says it rolled back: then how its compensation went is
    // what it ended with (spec 10.7.3), a failed one
    // `workflow.compensation_failed`, never masked as a cancel. No
    // definition Grasp builds registers a compensation yet (GRA-984), so
    // no real path reaches that case to test it.
    const marked = cancelMarkIn(this.ctx.storage.sql) !== undefined;
    const rolledBack =
      live !== undefined && "rollback" in live && live.rollback !== undefined;
    const stoppedEnd = marked && latest.status === "errored" && !rolledBack;
    const engine = {
      status: stoppedEnd ? "terminated" : latest.status,
      at: latest.timestamp,
      sequence: latest.sequence,
      ...this.#compensationOf(latest.status),
    } as const;
    // Its notification of its end, the once its failure is read: a later
    // one (how a rollback went) finds its row ended, and changes nothing.
    const failure =
      latest.status === "errored" && live?.status === "errored" && !stoppedEnd
        ? live.error
        : undefined;
    const failureCode = failure?.code ?? null;
    await (pin.type === "resource"
      ? projectResourceRun(
          this.env,
          latest.instanceId,
          engine,
          failureCode,
          async () =>
            failure === undefined ? null : await this.#failedTask(pin, failure)
        )
      : projectCandidateRun(this.env, latest.instanceId, engine, failureCode));
    // A page's pause or resume of it settles from where the engine has
    // the run now, and which controls it took, read together here from
    // its journal (resource-runs.ts).
    if (type === "resource") {
      await settleResourceControls(
        this.env,
        latest.instanceId,
        this.controlState()
      );
    }
    // Then what its fenced attempts still hold of the client's shares
    // comes back: after its row, so a run that
    // ended cancelled has its attempts charged up to their deadlines
    // (quotas.ts, `sharesReleased`).
    const run = this.instanceId();
    if (run !== undefined) {
      await this.#sharesReleased(run, marked);
    }
  }

  /**
   * The task whose step's failure ended the run, as its row keeps it
   * (`failed_task`): the last step in its own journal that failed with the
   * code the run ended with (`failure`), as its build's table of
   * tasks places it (`sealedStepOf`), or, for a round or a wait of core's
   * own (a retry, a held call timed out: host.ts), the task step it is of,
   * by its key. Read once, as the run ends failed. None when no step of a
   * task did: a raise ended it, say, after a step whose failure a catch
   * took. A build that can't be read names none, logged: the run's end
   * never waits on it, as a run whose build was tampered with fails for
   * that very reason.
   */
  async #failedTask(
    pin: PinnedResourceRun,
    failure: WorkflowError
  ): Promise<string | null> {
    let steps: ReturnType<typeof sealedStepsOf>;
    try {
      steps = sealedStepsOf(
        await loadWorkflowBuild(
          this.env,
          pin.workflow,
          pin.version,
          pin.manifest
        )
      );
    } catch (error) {
      log.error("workflow.failed_task_unread", {
        runId: this.instanceId(),
        ...errorFields(error),
      });
      return null;
    }
    // The journal's steps, its task steps by name, and the last step that
    // failed with the run's error, by its code (its message may come back
    // cut): every page in one synchronous turn.
    const names = new Set<string>();
    const tasks = new Map<string, string>();
    let failed: string | undefined;
    let after = 0;
    let more = true;
    while (more) {
      const page = this.history({ after, limit: historyPage });
      if (page === undefined || page.records.length === 0) {
        break;
      }
      for (const record of page.records) {
        after = record.eventId;
        if (record.unreadable || record.step === null) {
          continue;
        }
        const { name } = record.step;
        names.add(name);
        const placed = sealedStepOf(name, steps);
        if (placed !== undefined) {
          tasks.set(name, placed.task);
        }
        if (
          record.type === "step_errored" &&
          record.error?.code === failure.code
        ) {
          failed = name;
        }
      }
      ({ more } = page);
    }
    return failed === undefined ? null : await taskOfStep(failed, tasks, names);
  }

  /**
   * The run's compensation as its journal has it now (spec 10.7.3): while
   * it rolls back, why (its failure and the code it failed with, or a
   * cancellation); once it ended having rolled back, how that went. Read
   * from the run's own journal, and given only with a notification of the
   * same state (`notified`): a rollback's end only with an end, its cause
   * only while it rolls back, so a late notification never carries what a
   * newer state says.
   */
  #compensationOf(
    notified: RunNotification["status"]
  ): Pick<EngineStatus, "rollback" | "compensation"> {
    const live = this.status();
    if (live?.status !== notified) {
      return {};
    }
    const rollback =
      live !== undefined && "rollback" in live ? live.rollback : undefined;
    const cause = this.rollbackCause();
    return {
      ...(rollback === undefined ? {} : { rollback: rollback.status }),
      ...(cause === undefined
        ? {}
        : {
            compensation:
              cause.cause === "terminated"
                ? { cause: "cancellation", code: null }
                : { cause: "failure", code: cause.error.code ?? null },
          }),
    };
  }

  /**
   * Gives back what run `run`'s attempts the engine has fenced still hold
   * (quotas.ts, `sharesReleased`): paused, ended, cancelled, suspended or
   * taken over by a command. By the fence as the run stands now, read
   * from its own journal, never from a notification: one late or handed
   * over again frees nothing a newer activation's attempt holds, since the
   * fence only grows. Written only when the fence grew since the last
   * release this object made (`sharesTable`): an attempt of a generation
   * released takes no share again, so nothing is left to give back for
   * it. A cancelled run's attempts are charged up to their deadlines.
   */
  async #sharesReleased(run: string, cancelled: boolean): Promise<void> {
    const over = this.generationOver();
    if (over === undefined || over <= releasedThrough(this.ctx.storage.sql)) {
      return;
    }
    await sharesReleased(this.env, run, over, { cancelled });
    const { sql } = this.ctx.storage;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${sharesTable} (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), released INTEGER NOT NULL)`
    );
    sql.exec(
      `INSERT INTO ${sharesTable} (singleton, released) VALUES (1, ?) ON CONFLICT (singleton) DO UPDATE SET released = max(released, excluded.released)`,
      over
    );
  }
}
