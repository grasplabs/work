import { executionErrors } from "@grasp-os/shared/workflows";

import { runObjectOf } from "./engine.ts";

// The fence of a v1 App call made for a step's attempt: a call carrying
// the attempt checks, just before it acts, that the attempt still holds
// its lease in the run's journal (spec 14.4). No workflow run makes such a
// call any more: a run reaches its App's code through sealed functions
// only, which the run host holds to the attempt's lease itself
// (`RunHost.#callFunction`), and no other App's exports. What still
// carries a fence is the v1 App call path, removed with this in slice 4
// of GRA-789.

/**
 * Who a step's attempt is, as its host knows it: its run, its step's key
 * in the engine, its number and the generation of the activation that
 * claimed it. Core's own: never shown to App or workflow code.
 */
export interface AttemptFence {
  run: string;
  key: string;
  number: number;
  generation: number;
}

/**
 * Refuses, with `execution.stale_attempt`, what an attempt that no longer
 * holds its lease would do (`fence`); a call no attempt made (`undefined`)
 * passes. Asked of the run's object, the only authority on its leases.
 * `app`: the App whose method the attempt starts, which the run's object
 * keeps, to revoke that App's calls for the run should it be cancelled or
 * an activation of it let go of (run-object.ts, `revokeCalls`).
 */
export const requireAttemptHolds = async (
  env: Env,
  fence: AttemptFence | undefined,
  app?: string
): Promise<void> => {
  if (fence === undefined) {
    return;
  }
  const holds = await runObjectOf(env, fence.run).attemptHolds(
    fence.key,
    fence.number,
    fence.generation,
    app
  );
  if (!holds) {
    throw executionErrors.create("execution.stale_attempt");
  }
};
