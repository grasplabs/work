import type {
  DefinitionIdentity,
  WorkflowDefinition,
} from "@grasp-os/workerflow/contracts";
import { WorkflowRun } from "@grasp-os/workerflow/run";

import { runPinned } from "./dispatcher.ts";
import { pinOf } from "./engine.ts";
import type { BusyBudget } from "./host.ts";

/**
 * Where a run keeps each step's last busy-budget refusal (host.ts), in its
 * object's key-value storage, beside and apart from the engine's journal:
 * each retry of a step may run in an activation of its own.
 */
const busyPrefix = "grasp:busy:";

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
          busyRefusals: {
            get: (key) =>
              this.ctx.storage.kv.get<BusyBudget>(`${busyPrefix}${key}`),
            set: (key, refusal) => {
              this.ctx.storage.kv.put(`${busyPrefix}${key}`, refusal);
            },
          },
        }),
    };
  }
}
