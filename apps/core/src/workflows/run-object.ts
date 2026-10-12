import { errorPayloadSchema } from "@grasp-os/shared/errors";
import type {
  DefinitionIdentity,
  WorkflowDefinition,
} from "@grasp-os/workerflow/contracts";
import { WorkflowRun } from "@grasp-os/workerflow/run";

import { runPinned } from "./dispatcher.ts";
import { pinOf } from "./engine.ts";
import type { BusyRefusals } from "./host.ts";

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

// The object every workflow run lives in (`WORKFLOW_RUNS`): Workerflow's
// run object, one per run, which core reaches only through engine.ts. It
// is the only authority on a run's execution: its steps, waits, attempts
// and lifecycle. Core gives it one thing, the definition a run executes,
// resolved afresh on every activation from the version the run was
// created with (engine.ts, `pinOf`): the dispatcher loads the run's row,
// its authority and its code at the pinned version (dispatcher.ts).
//
// No route reaches it: it is registered privately, its namespace bound to
// core alone.

export class WorkflowRuns extends WorkflowRun<Env> {
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
      run: async (event, step) =>
        await runPinned(this.env, pin, event, step, {
          busyRefusals: busyRefusalsIn(this.ctx.storage.sql),
        }),
    };
  }
}
