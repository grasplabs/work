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

import { appHost } from "../durable-objects.ts";
import type { AttemptFence } from "./attempt-fence.ts";
import { runPinned } from "./dispatcher.ts";
import { pinOf } from "./engine.ts";
import { newAiCalls } from "./host.ts";
import type { AiCalls, BusyRefusals } from "./host.ts";
import { completeCancel, projectStatus } from "./runs.ts";

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

/** How long a cancel's request has to finish it before the object does. */
const cancelRepairMs = 5000;

/** The cancel a run is marked with (`markCancelled`). */
interface CancelMark {
  runId: string;
  actor: AuditActor;
  at: number;
  settled?: boolean;
}

/** The cancel kept in `sql`, if any (`markCancelled`). */
const cancelMarkIn = (sql: SqlStorage): CancelMark | undefined => {
  const [row] = sql
    .exec<{ run_id: string; actor: string; at: number; settled: number }>(
      `SELECT run_id, actor, at, settled FROM ${cancelTable} LIMIT 1`
    )
    .toArray();
  return row === undefined
    ? undefined
    : {
        runId: row.run_id,
        actor: auditActorSchema.parse(JSON.parse(row.actor)),
        at: row.at,
        settled: row.settled === 1,
      };
};

/** Whether the run in `sql` was marked cancelled (`markCancelled`). */
const cancelledIn = (sql: SqlStorage): boolean =>
  sql
    .exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      cancelTable
    )
    .toArray().length > 0;

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
        const generation = this.generation();
        if (generation !== undefined) {
          await revokeOrLog(event.instanceId, async () => {
            await this.revokeCalls(event.instanceId, generation);
          });
        }
        return await runPinned(this.env, pin, event, step, {
          busyRefusals: busyRefusalsIn(this.ctx.storage.sql),
          aiCalls: this.#aiCalls,
          leaseOf: (key, attempt) => this.#leaseOf(key, attempt),
          revokeAttempt: async (fence) => {
            await revokeOrLog(event.instanceId, async () => {
              await this.revokeAttemptCalls(fence);
            });
          },
        });
      },
    };
  }

  /**
   * Marks the run cancelled in its object, the first step of a cancel and
   * its record (runs.ts, `cancelRun`): who cancelled it and when, kept with
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
      `CREATE TABLE IF NOT EXISTS ${cancelTable} (run_id TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0)`
    );
    if (cancelMarkIn(sql) === undefined) {
      sql.exec(
        `INSERT INTO ${cancelTable} (run_id, actor, at) VALUES (?, ?, ?)`,
        runId,
        JSON.stringify(actor),
        at
      );
    }
    const mark = cancelMarkIn(sql);
    if (mark === undefined) {
      throw new Error(`Run ${runId}'s cancel wasn't kept`);
    }
    // Armed for the cancel's repair, should its request not finish it.
    const due = Date.now() + cancelRepairMs;
    const armed = await this.ctx.storage.getAlarm();
    if (armed === null || armed > due) {
      await this.ctx.storage.setAlarm(due);
    }
    // Then, before the cancel is recorded anywhere else, every call the
    // run's attempts started in an App is revoked there (`revokeCalls`):
    // a stub call that passed this object's check before the mark, and
    // awaits the App's own, is refused by it. Should an App not hear of
    // it, this fails, and the alarm armed above revokes again before it
    // finishes the cancel.
    await this.revokeCalls(mark.runId, null);
    return mark;
  }

  /** Records that the run's cancel is done (`markCancelled`). */
  settleCancel(): void {
    const { sql } = this.ctx.storage;
    if (cancelledIn(sql)) {
      sql.exec(`UPDATE ${cancelTable} SET settled = 1`);
    }
  }

  /**
   * Finishes a cancel its request didn't (`markCancelled`), then does what
   * the engine's alarm does. The cancel is finished as its request would:
   * the run's row tombstoned and the cancel audited, once whoever gets
   * there first, and the run terminated.
   */
  override async alarm(): Promise<void> {
    const { sql } = this.ctx.storage;
    const mark = cancelledIn(sql) ? cancelMarkIn(sql) : undefined;
    if (mark !== undefined && mark.settled !== true) {
      try {
        await this.revokeCalls(mark.runId, null);
        await completeCancel(this.env, mark);
        await this.terminate({ rollback: false });
        this.settleCancel();
      } catch (error) {
        // Tried again by the engine's next alarm, which a run that goes
        // on has; one that doesn't is cancelled again by its next request.
        log.error("workflow.cancel_repair_failed", {
          runId: mark.runId,
          ...errorFields(error),
        });
      }
    }
    await super.alarm();
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
   * holds its lease under `generation`, and its deadline hasn't passed:
   * what a call an attempt started beyond its host (an App method, an
   * export, and the stub calls they make) checks before it acts
   * (attempt-fence.ts). Read from the journal; tells nothing else.
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

  /**
   * Revokes the calls of one attempt of the run (`fence`) in every App an
   * attempt of it started a method of, once its function has returned.
   */
  async revokeAttemptCalls(fence: AttemptFence): Promise<void> {
    await Promise.all(
      this.#appsCalled().map(async (app) => {
        await appHost(this.env, app).revokeAttemptCalls(fence);
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
    if (pin?.type !== "app") {
      return;
    }
    await projectStatus(this.env, latest.instanceId, {
      status: latest.status,
      at: latest.timestamp,
      sequence: latest.sequence,
    });
  }
}
