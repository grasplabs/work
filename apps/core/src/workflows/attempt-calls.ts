import { workflowErrors } from "@grasp-os/shared/workflows";

import { isCpuLimitKill } from "./host.ts";

// The calls of a run's activation into its isolate, one per step attempt,
// as a run's host hears of them: what an activation needs once the Loader
// stopped the isolate past its CPU time (`afterCpuKill`). Shared by every
// kind of run whose code runs in an isolate: an App's (dispatcher.ts) and
// an independent workflow's (resource-runs.ts).

/** An attempt's call into the run's isolate, as it started (`attemptCall`). */
export interface AttemptCall {
  call: Promise<unknown>;
  /** Settles once the attempt's step ends in this activation. */
  stepDone: Promise<unknown>;
  /**
   * Whether its step has ended (`stepDone` settled): an attempt that timed
   * out may still be out in the isolate after its step failed, and the
   * workflow caught that and went on.
   */
  ended: boolean;
  /**
   * Whether its step had ended before its call settled: an attempt the
   * engine timed out, left out in the isolate. Its call ending with the
   * isolate says nothing of where the CPU time went.
   */
  outlivedStep: boolean;
}

/**
 * A host's `attemptCall` hook that keeps each call in `calls`: observed,
 * never left to reject unhandled (the host awaits it), and marked ended
 * once its step is.
 */
export const trackAttemptCalls =
  (calls: AttemptCall[]) =>
  (call: Promise<unknown>, stepDone: Promise<unknown>): void => {
    const attempt: AttemptCall = {
      call,
      stepDone,
      ended: false,
      outlivedStep: false,
    };
    const observed = async (): Promise<null> => {
      try {
        await call;
      } catch {
        // The host awaits it, and reports what it settles with.
      }
      // A step ends only once its attempt's call settled (host.ts, `do`),
      // unless the engine gave up on that attempt first.
      attempt.outlivedStep = attempt.ended;
      return null;
    };
    const ending = async (): Promise<null> => {
      // It never rejects (host.ts, `do`).
      await stepDone;
      attempt.ended = true;
      return null;
    };
    void observed();
    void ending();
    calls.push(attempt);
  };

/**
 * What a run fails with when its code spent its CPU time outside any step:
 * the run's failure, not a step's timeout.
 */
const spentOutsideSteps = (thrown: unknown): Error => {
  const failure = workflowErrors.create("workflow.run_failed");
  failure.message = "The workflow's code ran out of CPU time outside any step.";
  failure.cause = thrown;
  return failure;
};

/**
 * What an activation does once the Loader stopped the run's isolate past
 * its CPU time (`thrown`, by the run's call into it): fails the run, as for
 * any error of its isolate, unless an attempt was cut off with it. The
 * host failed each such attempt as a retryable timeout (host.ts,
 * `isCpuLimitKill`), and fails any later one of this activation so too,
 * so the engine parks its step for its retry and the activation
 * suspends until then, as for a wait: the next one replays in a fresh
 * isolate, with a fresh limit, rather than the run fail for CPU earlier
 * steps spent. Should such a step end in this activation instead (its
 * last attempt, or every retry due at once), the run fails with its
 * failure. Code spending the time outside any attempt fails the run
 * (`spentOutsideSteps`).
 */
export const afterCpuKill = async (
  thrown: unknown,
  calls: readonly AttemptCall[]
): Promise<never> => {
  if (!isCpuLimitKill(thrown)) {
    throw thrown;
  }
  // Each attempt's call ends with the isolate; waited for, as the run's
  // own call may end first.
  const attempts: Promise<unknown>[] = [];
  for (const { call } of calls) {
    attempts.push(call);
  }
  const outcomes = await Promise.allSettled(attempts);
  // Only attempts the kill cut off in their step: one whose step ended
  // before (it timed out, and the workflow went on) was in no step then.
  const killed = calls.filter((attempt, index) => {
    const outcome = outcomes[index];
    return (
      !attempt.outlivedStep &&
      outcome?.status === "rejected" &&
      isCpuLimitKill(outcome.reason)
    );
  });
  if (killed.length === 0) {
    throw spentOutsideSteps(thrown);
  }
  // Only steps still under way are retried: one the kill ended in this
  // activation (its last attempt) fails the run with its failure.
  const cutOff = killed.filter((attempt) => !attempt.ended);
  if (cutOff.length > 0) {
    const steps: Promise<unknown>[] = [];
    for (const { stepDone } of cutOff) {
      steps.push(stepDone);
    }
    // Never settles while each such step is parked: the engine suspends
    // the run, and the next activation replays it.
    await Promise.race(steps);
  }
  throw thrown;
};
