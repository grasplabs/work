import { executionErrors } from "@grasp-os/shared/workflows";

import { runObjectOf } from "./engine.ts";

// A step attempt's calls reach beyond its host: its App's methods (and the
// stub calls they make), other Apps' exports. Each carries who the attempt
// is, and every stub call it makes checks, just before it acts, that the
// attempt still holds its lease in the run's journal: once the engine gave
// up on the attempt (it timed out, the run was cancelled, or another
// activation took over), nothing started on its behalf acts any more,
// however many hops away (spec 14.4).

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
 */
export const requireAttemptHolds = async (
  env: Env,
  fence: AttemptFence | undefined
): Promise<void> => {
  if (fence === undefined) {
    return;
  }
  const holds = await runObjectOf(env, fence.run).attemptHolds(
    fence.key,
    fence.number,
    fence.generation
  );
  if (!holds) {
    throw executionErrors.create("execution.stale_attempt");
  }
};
