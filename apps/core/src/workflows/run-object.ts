import { auditActorSchema } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type {
  DefinitionIdentity,
  WorkflowDefinition,
} from "@grasp-os/workerflow/contracts";
import { WorkflowRun } from "@grasp-os/workerflow/run";
import type { RunNotification } from "@grasp-os/workerflow/run";
import { z } from "zod";

import { appHost } from "../durable-objects.ts";
import { projectCandidateRun } from "./candidate-runs.ts";
import { settleControls } from "./controls.ts";
import { runPinned } from "./dispatcher.ts";
import { pinOf } from "./engine.ts";
import { newAiCalls } from "./host.ts";
import type { AiCalls, BusyRefusals } from "./host.ts";
import { sharesReleased } from "./quotas.ts";
import type {
  ActionModelCalls,
  ScopeFences,
  TriedOnceMarks,
} from "./resource-host.ts";
import { projectResourceRun } from "./resource-runs.ts";
import { completeCancel, projectStatus } from "./runs.ts";
import { wakeQueueFronts } from "./share-wakes.ts";

/**
 * Where a run keeps each step's last busy-budget refusal (host.ts): a
 * table of its object's SQLite, beside the engine's journal, as each retry
 * of a step may run in an activation of its own. The engine's removal of
 * a run (a delete, or its purge once retention ends) drops every table of
 * the object but its tombstones (workerflow's `removeJournal`), this one
 * with them: nothing of the run outlives its retention.
 */
const busyTable = "grasp_busy_refusals";

/** A kept refusal's details, as the gateway gave them. */
const busyDetailsSchema = errorPayloadSchema.shape.details.unwrap();

/** The run's busy-budget refusals, kept with it (`busyTable`). */
export const busyRefusalsIn = (sql: SqlStorage): BusyRefusals => ({
  get: (step) => {
    const exists =
      sql
        .exec(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
          busyTable
        )
        .toArray().length > 0;
    const [row] = exists
      ? sql
          .exec<{ at: number; details: string | null }>(
            `SELECT at, details FROM ${busyTable} WHERE step = ?`,
            step
          )
          .toArray()
      : [];
    return (
      row && {
        at: row.at,
        details:
          row.details === null
            ? undefined
            : busyDetailsSchema.parse(JSON.parse(row.details)),
      }
    );
  },
  set: (step, { at, details }) => {
    // Only while the run is there: a late call of an activation whose run
    // was removed leaves nothing behind.
    const live =
      sql
        .exec(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run'"
        )
        .toArray().length > 0;
    if (!live) {
      return;
    }
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${busyTable} (step TEXT PRIMARY KEY, at INTEGER NOT NULL, details TEXT)`
    );
    sql.exec(
      `INSERT INTO ${busyTable} (step, at, details) VALUES (?, ?, ?) ON CONFLICT (step) DO UPDATE SET at = excluded.at, details = excluded.details`,
      step,
      at,
      details === undefined ? null : JSON.stringify(details)
    );
  },
});

/**
 * Where a run keeps the attempts of its steps tried once (resource-host.ts,
 * `TriedOnceMarks`): a table of its object's SQLite beside the engine's
 * journal, dropped with it as `busyTable` is. Only the host writes it,
 * never the run's code.
 */
const triedOnceTable = "grasp_tried_once";

/** Whether the run's own table is there: a run removed keeps nothing. */
const runIsThere = (sql: SqlStorage): boolean =>
  sql
    .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run'")
    .toArray().length > 0;

/** Whether the table of tried-once attempts is there yet. */
const hasTriedOnce = (sql: SqlStorage): boolean =>
  sql
    .exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      triedOnceTable
    )
    .toArray().length > 0;

/** One row of `triedOnceTable`, as the host reads it. */
const triedOnceRow = (
  sql: SqlStorage,
  key: string,
  attempt: number
): { unstarted: number; failure: string | null } | undefined => {
  if (!hasTriedOnce(sql)) {
    return undefined;
  }
  const [row] = sql
    .exec<{ unstarted: number; failure: string | null }>(
      `SELECT unstarted, failure FROM ${triedOnceTable} WHERE key = ? AND attempt = ?`,
      key,
      attempt
    )
    .toArray();
  return row;
};

/** Writes an attempt's row, while the run is there. */
const writeTriedOnce = (
  sql: SqlStorage,
  key: string,
  attempt: number,
  values: { unstarted?: 1; failure?: string }
): void => {
  if (!runIsThere(sql)) {
    return;
  }
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${triedOnceTable} (key TEXT NOT NULL, attempt INTEGER NOT NULL, unstarted INTEGER NOT NULL DEFAULT 0, failure TEXT, PRIMARY KEY (key, attempt))`
  );
  sql.exec(
    `INSERT INTO ${triedOnceTable} (key, attempt, unstarted, failure) VALUES (?, ?, ?, ?) ON CONFLICT (key, attempt) DO UPDATE SET unstarted = max(unstarted, excluded.unstarted), failure = coalesce(excluded.failure, failure)`,
    key,
    attempt,
    values.unstarted ?? 0,
    values.failure ?? null
  );
};

/** A kept failure, as the host kept it: a step's error, or nothing. */
const keptFailureSchema = z.object({
  name: z.string(),
  message: z.string(),
  code: z.string().optional(),
});

/**
 * The settled scopes of the run's items and branches (resource-host.ts,
 * `ScopeFences`): a table of its object's SQLite beside the engine's
 * journal, dropped with it, one row a scope of the run's current
 * execution, so a restarted run settles its scopes anew. Only the host
 * writes it, never the run's code.
 */
const fencesTable = "grasp_scope_fences";

/** The run's current execution, as the engine keeps it. */
const executionOf = (sql: SqlStorage): string | undefined => {
  if (!runIsThere(sql)) {
    return undefined;
  }
  const [row] = sql
    .exec<{ execution: string }>("SELECT execution_uid AS execution FROM run")
    .toArray();
  return row?.execution;
};

/** Whether the table of settled scopes is there yet. */
const hasFences = (sql: SqlStorage): boolean =>
  sql
    .exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      fencesTable
    )
    .toArray().length > 0;

/** The branch scope `place` of `execution` settled on, if it did. */
const fenceOf = (
  sql: SqlStorage,
  execution: string,
  place: string
): number | undefined => {
  if (!hasFences(sql)) {
    return undefined;
  }
  const [row] = sql
    .exec<{ branch: number }>(
      `SELECT branch FROM ${fencesTable} WHERE execution = ? AND place = ?`,
      execution,
      place
    )
    .toArray();
  return row?.branch;
};

/** The run's settled scopes, kept with it (`fencesTable`). */
export const fencesIn = (sql: SqlStorage): ScopeFences => ({
  settle: (place, branch) => {
    const execution = executionOf(sql);
    if (execution === undefined) {
      return branch;
    }
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${fencesTable} (execution TEXT NOT NULL, place TEXT NOT NULL, branch INTEGER NOT NULL, PRIMARY KEY (execution, place))`
    );
    // The first writer's: a scope settles once, whoever asks again.
    sql.exec(
      `INSERT OR IGNORE INTO ${fencesTable} (execution, place, branch) VALUES (?, ?, ?)`,
      execution,
      place,
      branch
    );
    return fenceOf(sql, execution, place) ?? branch;
  },
  settled: (place) => {
    const execution = executionOf(sql);
    return execution === undefined ? undefined : fenceOf(sql, execution, place);
  },
});

/** The run's tried-once attempts, kept with it (`triedOnceTable`). */
export const triedOnceIn = (sql: SqlStorage): TriedOnceMarks => ({
  markUnstarted: (key, attempt) => {
    writeTriedOnce(sql, key, attempt, { unstarted: 1 });
  },
  unstarted: (key, attempt) => triedOnceRow(sql, key, attempt)?.unstarted === 1,
  keepFailure: (key, attempt, error) => {
    writeTriedOnce(sql, key, attempt, { failure: JSON.stringify(error) });
  },
  failureOf: (key, attempt) => {
    const failure = triedOnceRow(sql, key, attempt)?.failure ?? null;
    const kept =
      failure === null
        ? undefined
        : keptFailureSchema.safeParse(JSON.parse(failure)).data;
    return kept === undefined
      ? undefined
      : {
          name: kept.name,
          message: kept.message,
          ...(kept.code === undefined ? {} : { code: kept.code }),
        };
  },
});

/**
 * Where a run keeps the model calls its JSON workflow's actions made
 * (resource-host.ts, `ActionModelCalls`; GRA-700): a table of its object's
 * SQLite beside the engine's journal, dropped with it as `triedOnceTable`
 * is. Only the host writes it, never the run's code. Written before the
 * call goes out: the object's output gate holds the call until the write
 * is durable, so a call made always counts.
 */
const modelCallsTable = "grasp_action_model_calls";

/** The model calls the run's actions made, kept with it (`modelCallsTable`). */
export const modelCallsIn = (sql: SqlStorage): ActionModelCalls => ({
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
 * Where a run's object keeps that the run was cancelled (`markCancelled`):
 * a table of its SQLite beside the engine's journal, which the engine's
 * removal of the run drops with it, as `busyTable`.
 */
const cancelTable = "grasp_run_cancelled";

/** Revokes App calls (`revoke`), logging rather than failing the run. */
const revokeOrLog = async (
  runId: string,
  revoke: () => Promise<void>
): Promise<void> => {
  try {
    await revoke();
  } catch (error) {
    log.error("workflow.revoke_calls_failed", {
      runId,
      ...errorFields(error),
    });
  }
};

/**
 * The Apps an attempt of the run started a method of (`attemptHolds`),
 * whose calls for the run a cancel revokes (`revokeCalls`): a table the
 * engine drops with the run, as `cancelTable`.
 */
const appsTable = "grasp_run_apps";

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

/** Whether the run in `sql` was marked cancelled (`markCancelled`). */
const cancelledIn = (sql: SqlStorage): boolean =>
  sql
    .exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      cancelTable
    )
    .toArray().length > 0;

/**
 * The cancel a run is marked with (`markCancelled`): whether it is done
 * (`settled`), whether the App calls of the run were revoked
 * (`revoked`), and when the object next tries what isn't (`due`).
 */
interface CancelMark {
  runId: string;
  actor: AuditActor;
  at: number;
  settled?: boolean;
  revoked?: boolean;
  due?: number;
}

/** The cancel kept in `sql`, if any (`markCancelled`). */
const cancelMarkIn = (sql: SqlStorage): CancelMark | undefined => {
  if (!cancelledIn(sql)) {
    return undefined;
  }
  const [row] = sql
    .exec<{
      run_id: string;
      actor: string;
      at: number;
      settled: number;
      revoked: number;
      due: number;
    }>(
      `SELECT run_id, actor, at, settled, revoked, due FROM ${cancelTable} LIMIT 1`
    )
    .toArray();
  return row === undefined
    ? undefined
    : {
        runId: row.run_id,
        actor: auditActorSchema.parse(JSON.parse(row.actor)),
        at: row.at,
        settled: row.settled === 1,
        revoked: row.revoked === 1,
        due: row.due,
      };
};

/** Whether `mark` leaves the object something to do (`alarm`). */
const unfinished = (mark: CancelMark | undefined): mark is CancelMark =>
  mark !== undefined && (mark.settled !== true || mark.revoked !== true);

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
// engine, and only the engine (runs.ts, `projectStatus`).
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
        // A new activation: whatever an older one started in an App is let
        // go of there too, before this one runs anything. Should an App
        // not hear of it, the run goes on: its older attempts hold no
        // lease, so every check of the run's object refuses them still;
        // only a call already past that check, awaiting the App's, isn't
        // refused there as well.
        // Not awaited: the run doesn't wait on its Apps.
        const generation = this.generation();
        if (generation !== undefined) {
          this.ctx.waitUntil(
            revokeOrLog(event.instanceId, async () => {
              await this.revokeCalls(event.instanceId, generation);
            })
          );
        }
        // Marked cancelled: an activation that starts now (an event came,
        // a wait's alarm fired) runs nothing of the run, and finishes the
        // cancel instead (`#finishCancel`).
        const mark = cancelMarkIn(this.ctx.storage.sql);
        if (mark !== undefined) {
          await this.#finishCancel(mark);
          return null;
        }
        return await runPinned(this.env, pin, event, step, {
          busyRefusals: busyRefusalsIn(this.ctx.storage.sql),
          triedOnce: triedOnceIn(this.ctx.storage.sql),
          fences: fencesIn(this.ctx.storage.sql),
          modelCalls: modelCallsIn(this.ctx.storage.sql),
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
        });
      },
    };
  }

  /**
   * Marks the run cancelled in its object, the first step of a cancel and
   * its record (controls.ts, `cancelRun`): who cancelled it and when, kept with
   * the run until the cancel is done in core's database and the engine
   * (`settleCancel`). From then on no attempt of the run holds
   * (`#leaseOf`), so every fenced call of it is refused at once, in this
   * object, with no read of core's database, whatever happens to the rest
   * of the cancel. A second cancel finds the first's mark and finishes it.
   * Should the rest of the cancel fail, or its request die, the object
   * finishes it on its next alarm (`alarm`), which is armed here. A run
   * the engine has no journal of yet has no attempt to fence, and nothing
   * is kept: its start, should it come, finds its row cancelled. Once
   * marked, the App calls the run's attempts started are revoked
   * (`revokeCalls`). Answers the cancel the run is marked with.
   */
  async markCancelled(
    runId: string,
    actor: AuditActor,
    at: number
  ): Promise<CancelMark> {
    const { sql } = this.ctx.storage;
    const hasRun =
      sql
        .exec(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run'"
        )
        .toArray().length > 0;
    if (!hasRun) {
      return { runId, actor, at };
    }
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${cancelTable} (run_id TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL)`
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
      throw new Error(`Run ${runId}'s cancel wasn't kept`);
    }
    // Armed for the cancel's repair, should its request not finish it;
    // the engine's own alarms keep it (`extraAlarm`).
    await this.#armRepair(mark.due ?? Date.now() + cancelRepairMs);
    // Then, before the cancel is recorded anywhere else, every call the
    // run's attempts started in an App is revoked there (`revokeCalls`):
    // a stub call that passed this object's check before the mark, and
    // awaits the App's own, is refused by it. Should an App not hear of
    // it, the cancel goes on, and the object revokes again on its alarm:
    // this object's own check refuses those calls meanwhile.
    await this.#revokeForCancel(mark);
    return mark;
  }

  /**
   * Revokes the run's App calls for its cancel (`revokeCalls`), and keeps
   * that it did; should an App not hear of it, logs, and has the object's
   * alarm try again (`alarm`). Never throws.
   */
  async #revokeForCancel(mark: CancelMark): Promise<void> {
    try {
      await this.revokeCalls(mark.runId, null);
      this.ctx.storage.sql.exec(`UPDATE ${cancelTable} SET revoked = 1`);
    } catch (error) {
      log.error("workflow.revoke_calls_failed", {
        runId: mark.runId,
        ...errorFields(error),
      });
      await this.#repairLater();
    }
  }

  /**
   * Finishes the cancel `mark` records, as its request does: the App
   * calls revoked (`#revokeForCancel`), the run's row tombstoned and the
   * cancel audited, once whoever gets there first (runs.ts,
   * `completeCancel`), the run terminated and the mark settled.
   */
  async #finishCancel(mark: CancelMark): Promise<void> {
    if (mark.revoked !== true) {
      await this.#revokeForCancel(mark);
    }
    if (mark.settled === true) {
      return;
    }
    await completeCancel(this.env, mark);
    await this.terminate({ rollback: false });
    this.settleCancel();
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
    return unfinished(mark) ? (mark.due ?? null) : null;
  }

  /** Records that the run's cancel is done (`markCancelled`). */
  settleCancel(): void {
    const { sql } = this.ctx.storage;
    if (cancelledIn(sql)) {
      sql.exec(`UPDATE ${cancelTable} SET settled = 1`);
    }
  }

  /**
   * Aborts once the alarm running the run's activation returns
   * (`RunMemory.over`): only an alarm runs one.
   */
  #activation: AbortController | undefined;

  /**
   * Finishes a cancel its request didn't (`markCancelled`), then does what
   * the engine's alarm does. The cancel is finished as its request would:
   * the run's row tombstoned and the cancel audited, once whoever gets
   * there first, and the run terminated.
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
          runId: mark.runId,
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
   * marked cancelled (`markCancelled`): then no attempt of it holds.
   */
  #leaseOf(key: string, attempt: number) {
    return cancelledIn(this.ctx.storage.sql)
      ? undefined
      : this.attemptLease(key, attempt);
  }

  /**
   * Whether the attempt `attempt` of the step whose key is `key` still
   * holds its lease under `generation`, and its deadline hasn't passed
   * (attempt-fence.ts). Read from the journal; tells nothing else. No
   * workflow run starts a call it fences any more: a run's calls of its
   * App's code are sealed functions, held by the run host's own lease
   * checks. What remains asks of v1 App calls, which slice 4 of GRA-789
   * removes with this.
   */
  attemptHolds(
    key: string,
    attempt: number,
    generation: number,
    app?: string
  ): boolean {
    const lease = this.#leaseOf(key, attempt);
    const holds =
      lease !== undefined &&
      lease.generation === generation &&
      Date.now() < lease.deadline;
    if (holds && app !== undefined) {
      // An App whose method an attempt of the run starts: its calls for
      // the run are revoked should the run be cancelled (`revokeCalls`).
      const { sql } = this.ctx.storage;
      sql.exec(
        `CREATE TABLE IF NOT EXISTS ${appsTable} (app TEXT PRIMARY KEY)`
      );
      sql.exec(`INSERT OR IGNORE INTO ${appsTable} (app) VALUES (?)`, app);
    }
    return holds;
  }

  /**
   * Revokes, in every App an attempt of run `runId` started a method of,
   * the App's calls for it: of every attempt (`below` null), once it is
   * cancelled, or of the activations before generation `below`, once
   * another took over (App.ts, `revokeRunCalls`). The App's own
   * synchronous checks then refuse them, so nothing awaited between a
   * check here and one there lets such a call act. Repeating it changes
   * nothing.
   */
  async revokeCalls(runId: string, below: number | null): Promise<void> {
    await Promise.all(
      this.#appsCalled().map(async (app) => {
        await appHost(this.env, app).revokeRunCalls(runId, below);
      })
    );
  }

  /** The Apps an attempt of the run started a method of (`attemptHolds`). */
  #appsCalled(): AppId[] {
    const { sql } = this.ctx.storage;
    const known =
      sql
        .exec(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
          appsTable
        )
        .toArray().length > 0;
    if (!known) {
      return [];
    }
    return sql
      .exec<{ app: string }>(`SELECT app FROM ${appsTable}`)
      .toArray()
      .map(({ app }) => appIdSchema.parse(app));
  }

  /**
   * Takes the run's status changes: the newest of each batch is all core's
   * record needs, as a later status replaces an earlier one. A run of
   * core's own (an upload's extraction, a build) has no row to follow it.
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
      // An independent workflow's run, or a test run of its draft: no
      // cancel or control of it exists yet, so its row follows the
      // engine's status alone.
      // Why it failed, from its own journal: kept on its row, so the code
      // outlives the engine's record of the run.
      const live = this.status();
      const project =
        pin.type === "resource" ? projectResourceRun : projectCandidateRun;
      await project(
        this.env,
        latest.instanceId,
        {
          status: latest.status,
          at: latest.timestamp,
          sequence: latest.sequence,
        },
        live?.status === "errored" ? (live.error.code ?? null) : null
      );
      // Then what its fenced attempts still hold of the client's shares
      // comes back, as an App run's does: after its row, so a run that
      // ended cancelled has its attempts charged up to their deadlines
      // (quotas.ts, `sharesReleased`).
      const run = this.instanceId();
      if (run !== undefined) {
        await this.#sharesReleased(run, false);
      }
      return;
    }
    if (pin?.type !== "app") {
      return;
    }
    // The run this object holds, from its own journal: a batch naming
    // another is no notification of this run, and acts on none.
    const run = this.instanceId();
    if (
      run === undefined ||
      notifications.some(({ instanceId }) => instanceId !== run)
    ) {
      log.warn("workflow.notify_foreign_run", {
        runId: run,
        named: latest.instanceId,
      });
      return;
    }
    const mark = cancelMarkIn(this.ctx.storage.sql);
    // Beside the run's record, never behind it: whatever its attempts the
    // engine has fenced still hold of the client's shares comes back now,
    // not at their deadlines (`#sharesReleased`), whether or not what
    // core records of the run goes through, and without keeping that
    // record waiting. It depends on nothing the record writes.
    const released = this.#sharesReleased(run, mark !== undefined);
    const recorded = this.#statusRecorded(run, latest, mark);
    const [release, record] = await Promise.allSettled([released, recorded]);
    if (release.status === "rejected") {
      throw release.reason;
    }
    if (record.status === "rejected") {
      throw record.reason;
    }
  }

  /**
   * Makes core's record of run `run` follow the engine's `latest` status
   * (runs.ts, `projectStatus`), its cancel (`mark`) recorded first.
   */
  async #statusRecorded(
    run: string,
    latest: RunNotification,
    mark: CancelMark | undefined
  ): Promise<void> {
    // A run marked cancelled ends cancelled, however it ended: its cancel
    // is recorded in core first (`completeCancel`, once), so its row reads
    // it, rather than a failure its refused attempts led to.
    if (mark !== undefined && mark.settled !== true) {
      await completeCancel(this.env, mark);
    }
    await projectStatus(this.env, run, {
      status: latest.status,
      at: latest.timestamp,
      sequence: latest.sequence,
      ...(latest.firstActivatedAt === null
        ? {}
        : { startedAt: latest.firstActivatedAt }),
    });
    // A pause or resume settles from where the engine has the run now,
    // and which controls it took, read together here from its journal,
    // not from the notification.
    await settleControls(this.env, run, this.controlState());
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
    // Shares came back: the steps they let in ask now (share-wakes.ts).
    await wakeQueueFronts(this.env);
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
