import { platformLimits } from "@grasp-os/shared/platform-limits";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { RpcTarget } from "cloudflare:workers";

import type { RunHostCalls, Settled } from "./code.ts";

// The time a run's code spends outside its steps, bounded per activation.
// The run's call into its isolate (code.ts, `loadRunIsolate`) holds the
// run's alarm handler and an isolate (on-prem, a sandbox session holding a
// process) from its start until it ends or suspends. Inside a step, that
// time is the step's: its attempt holds a share and its lineage's active
// time up to its deadline (quotas.ts), and a wait suspends the run. Between
// steps it is nobody's: no attempt holds it, so no attempt's deadline
// bounds it, and none of the lineage's active time is used. Code that waits
// on a timer, or on a promise that never settles, between two steps would
// hold the isolate for as long as the alarm handler lasts, and do so again
// on every activation, which gives its first attempt whatever time is left.
//
// So each activation's code gets `platformLimits.workflowBetweenStepsMs`
// outside its steps, in all: the clock runs while the run's call is open
// (from when its code starts: on-prem, once its session opens, not while
// it waits for a place) and none of its step calls is out on the host, and
// stops while one is. Past the budget the run fails with
// `workflow.between_steps_limit`.
//
// From the threat model, each way code could hold an isolate longer, and
// what closes it:
//
// - Many short gaps: the budget is the activation's, in all, never reset
//   by a step, so a loop of quick steps refills nothing.
// - A step call kept out to stop the clock: a call out is a step the
//   engine bounds. An attempt runs to its deadline, charged to the
//   lineage; a wait or a parked retry suspends the activation, which lets
//   go of the isolate (`over`).
// - A new activation for a fresh budget: each one starts afresh, but
//   activations are bounded already. Each comes from a wait or a retry (a
//   step, counted against the run's steps and its attempts) or from a
//   recovery, and each runs within the alarm handler's wall time and the
//   lineage's age.
// - Code going on after the budget is spent: on Cloudflare the isolate's
//   call can't be killed, only dropped, so every step call it makes after
//   that is refused (it never settles, as the engine fences a call), and
//   no step of it runs. On-prem its session is aborted, ending its process.
// - Waiting for a sandbox place on-prem: no code of the run runs then, so
//   that time isn't counted; it is bounded on its own (code.ts,
//   `runLoadWaitMs`).
// - CPU time spent between steps: bounded apart, by the isolate's CPU limit
//   (code.ts, `workflowSandbox`).
//
// It is a bound, never a charge: nothing is written, and no run is charged
// more than its attempts used.

/**
 * How long each activation's code may spend outside its steps, in all:
 * the platform's, or a shorter one tests set (`WORKFLOW_BETWEEN_STEPS_MS`),
 * never a longer one.
 */
export const betweenStepsBudgetOf = (
  env: Pick<Env, "WORKFLOW_BETWEEN_STEPS_MS">
): number => {
  const set = Number(env.WORKFLOW_BETWEEN_STEPS_MS);
  return Number.isInteger(set) &&
    set > 0 &&
    set < platformLimits.workflowBetweenStepsMs
    ? set
    : platformLimits.workflowBetweenStepsMs;
};

/** What a run whose code spent its budget between steps fails with. */
const budgetSpent = (budgetMs: number): Error =>
  workflowErrors.create("workflow.between_steps_limit", {
    maxMs: budgetMs,
  });

/** What never settles: a step call made after the budget was spent. */
const neverSettles = async (): Promise<never> =>
  await Promise.withResolvers<never>().promise;

/**
 * One activation's clock of the time its run's code spends outside its
 * steps (see above).
 */
export interface BetweenSteps {
  /** Rejects with `workflow.between_steps_limit` once the budget is spent. */
  spent: Promise<never>;
  /** Aborts once the budget is spent, for whatever holds the isolate. */
  over: AbortSignal;
  /** The run's code has started: its first gap opens, unless a step is out. */
  started: () => void;
  /**
   * Runs `call`, one of the run's step calls, with the clock stopped while
   * it is out. Once the budget is spent it never settles: no step of the
   * run's starts after that.
   */
  around: <T>(call: () => Promise<T>) => Promise<T>;
  /** The run's call has ended: the clock stops for good. */
  ended: () => void;
}

/** A clock of `budgetMs` between steps, for one activation's run call. */
export const betweenSteps = (budgetMs: number): BetweenSteps => {
  /** Time spent between steps in the gaps that have closed. */
  let usedMs = 0;
  /** When the gap under way began, if one is. */
  let gapSince: number | undefined;
  /** Step calls out on the host now. */
  let out = 0;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const spent = Promise.withResolvers<never>();
  // Raced by the run's call, and by nothing once that has ended: never an
  // unhandled rejection either way.
  // oxlint-disable-next-line promise/prefer-await-to-then -- not awaited here
  spent.promise.catch(() => null);
  const over = new AbortController();

  const closeGap = (): void => {
    if (gapSince !== undefined) {
      usedMs += Date.now() - gapSince;
      gapSince = undefined;
    }
    clearTimeout(timer);
    timer = undefined;
  };
  const spend = (): void => {
    closeGap();
    const error = budgetSpent(budgetMs);
    spent.reject(error);
    over.abort(error);
  };
  const openGap = (): void => {
    if (over.signal.aborted || gapSince !== undefined) {
      return;
    }
    gapSince = Date.now();
    timer = setTimeout(spend, Math.max(0, budgetMs - usedMs));
  };

  return {
    spent: spent.promise,
    over: over.signal,
    started: () => {
      if (running) {
        return;
      }
      running = true;
      if (out === 0) {
        openGap();
      }
    },
    around: async (call) => {
      if (over.signal.aborted) {
        return await neverSettles();
      }
      out += 1;
      if (out === 1) {
        closeGap();
      }
      try {
        return await call();
      } finally {
        out -= 1;
        if (out === 0 && running) {
          openGap();
        }
      }
    },
    ended: () => {
      closeGap();
      running = false;
    },
  };
};

/**
 * `host` as a run's isolate calls it, each step call held to the
 * activation's clock of its time between steps (between-steps.ts): out,
 * its call stops the clock; once the budget is spent, none starts.
 */
export class BoundedRunHost<Attempt extends object>
  extends RpcTarget
  implements RunHostCalls<Attempt>
{
  readonly #host: RunHostCalls<Attempt>;
  readonly #clock: BetweenSteps;

  constructor(host: RunHostCalls<Attempt>, clock: BetweenSteps) {
    super();
    this.#host = host;
    this.#clock = clock;
  }

  async do(
    name: unknown,
    options: unknown,
    fn: (attempt: Attempt) => Promise<unknown>
  ): Promise<Settled<unknown>> {
    return await this.#clock.around(
      async () => await this.#host.do(name, options, fn)
    );
  }

  async sleep(name: unknown, duration: unknown): Promise<Settled<null>> {
    return await this.#clock.around(
      async () => await this.#host.sleep(name, duration)
    );
  }

  async sleepUntil(name: unknown, until: unknown): Promise<Settled<null>> {
    const { sleepUntil } = this.#host;
    if (sleepUntil === undefined) {
      return {
        ok: false,
        error: { name: "Error", message: "This run has no sleep until." },
      };
    }
    return await this.#clock.around(
      async () => await sleepUntil.call(this.#host, name, until)
    );
  }

  async waitForDecision(
    name: unknown,
    options: unknown
  ): Promise<Settled<unknown>> {
    return await this.#clock.around(
      async () => await this.#host.waitForDecision(name, options)
    );
  }
}
