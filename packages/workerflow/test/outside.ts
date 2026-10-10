import type {
  WorkflowRollbackContext,
  WorkflowStepContext,
} from "../src/contracts.ts";
import type { RunNotification } from "../src/notifications.ts";

/** One effect as the outside system received it. */
export interface Effect {
  run: string;
  label: string;
  key: string;
  attempt: number;
  /** What the outside system answered with. */
  receipt: string;
  /** When it arrived. */
  at: number;
  /** Its place among effects and handlers' ends (`tick`). */
  order?: number;
  /** For an undoing: what the rollback was given of its step. */
  undoing?: {
    stepKey: string;
    step: { name: string; count: number };
    output: unknown;
    error: { name: string; message: string };
  };
}

/**
 * The outside world the test definitions act on: it records each effect
 * it receives, answers with a receipt, and can withhold the answer to a
 * given attempt (the effect happened; the step hasn't heard back). The
 * test and the run objects share this module's state: the Workers pool
 * runs the main Worker's objects in the test's isolate.
 */
export const effects: Effect[] = [];

/**
 * A count the effects, the alarm handlers' ends and a test's own marks
 * take their place in: their order, where the clock (which stands still
 * within a turn) could give two the same time.
 */
const ordering = { next: 0 };

export const tick = (): number => {
  ordering.next += 1;
  return ordering.next;
};

const holds = new Map<
  string,
  {
    held: PromiseWithResolvers<true>;
    release: PromiseWithResolvers<true>;
  }
>();

const holdKey = (run: string, label: string, attempt: number): string =>
  JSON.stringify([run, label, attempt]);

/** How long a test waits for a held effect to arrive before it fails. */
const arrivalDeadlineMs = 5000;

/**
 * Withholds the answer to `label`'s `attempt` in `run`. `held` resolves once
 * the effect arrived, and rejects if it hasn't by the deadline; the answer
 * goes out on `release()`.
 */
export const hold = (
  run: string,
  label: string,
  attempt = 1
): { held: Promise<true>; release: () => void } => {
  const entry = {
    held: Promise.withResolvers<true>(),
    release: Promise.withResolvers<true>(),
  };
  holds.set(holdKey(run, label, attempt), entry);
  const arrived = new AbortController();
  const timedOut = async (): Promise<never> => {
    await scheduler.wait(arrivalDeadlineMs, { signal: arrived.signal });
    throw new Error(`${label} of ${run} never arrived`);
  };
  // Every test awaits what it holds; the timer stops once it arrived.
  const held = (async (): Promise<true> => {
    try {
      return await Promise.race([entry.held.promise, timedOut()]);
    } finally {
      arrived.abort();
    }
  })();
  return {
    held,
    release: () => {
      entry.release.resolve(true);
    },
  };
};

export const effectsOf = (run: string, label?: string): Effect[] =>
  effects.filter(
    (effect) =>
      effect.run === run && (label === undefined || effect.label === label)
  );

/** An effect from inside a step: recorded, then answered with a receipt. */
export const effect = async (
  run: string,
  label: string,
  context: WorkflowStepContext
): Promise<string> => {
  const receipt = `${label}#${effects.length + 1}`;
  effects.push({
    run,
    label,
    key: context.idempotencyKey,
    attempt: context.attempt,
    receipt,
    at: Date.now(),
    order: tick(),
  });
  const entry = holds.get(holdKey(run, label, context.attempt));
  if (entry !== undefined) {
    entry.held.resolve(true);
    await entry.release.promise;
  }
  return receipt;
};

/**
 * What the run objects' host took of their notifications, in the order it
 * took them (worker.ts).
 */
export const hostNotifications: RunNotification[] = [];

/** How many more deliveries the host fails, by instance ID. */
export const notifyFailures = new Map<string, number>();

/** Instance IDs whose next delivery the host never answers. */
export const notifyHangs = new Set<string>();

export const notifiedOf = (run: string): RunNotification[] =>
  hostNotifications.filter((notification) => notification.instanceId === run);

/** Each run object whose alarm handler has returned, by its ID. */
export const handled: string[] = [];

/** The same, with each handler's place in that order. */
export const handledAt: { object: string; order: number }[] = [];

/**
 * The engine's warnings while `during` runs (log.ts writes them through
 * console.warn): each is an object with an `event`.
 */
export const warningsDuring = async (
  during: () => Promise<unknown>
): Promise<unknown[]> => {
  const { warn } = console;
  const seen: unknown[] = [];
  console.warn = (...args: unknown[]): void => {
    seen.push(...args.slice(0, 1));
  };
  try {
    await during();
  } finally {
    console.warn = warn;
  }
  return seen;
};

/** The event a warning names, if it is one of the engine's. */
export const eventOf = (warning: unknown): unknown =>
  typeof warning === "object" && warning !== null && "event" in warning
    ? warning.event
    : undefined;

/**
 * A rollback's effect, undoing `label`'s: recorded under the rollback's own
 * key and attempt, with what it was given of its step; held as an effect
 * is, as `undo-<label>`.
 */
export const undone = async (
  run: string,
  label: string,
  context: WorkflowRollbackContext
): Promise<void> => {
  const undoing = `undo-${label}`;
  effects.push({
    run,
    label: undoing,
    key: context.idempotencyKey,
    attempt: context.attempt,
    receipt: `${undoing}#${effects.length + 1}`,
    at: Date.now(),
    undoing: {
      stepKey: context.ctx.idempotencyKey,
      step: { ...context.ctx.step },
      output: context.output,
      error: { name: context.error.name, message: context.error.message },
    },
  });
  const entry = holds.get(holdKey(run, undoing, context.attempt));
  if (entry !== undefined) {
    entry.held.resolve(true);
    await entry.release.promise;
  }
};

const checkpoints = new Map<string, number>();

/**
 * A wait in a definition outside any step (nothing journaled), which the
 * test can withhold like an effect's answer: `hold(run, label, n)` holds
 * the n-th time any activation of `run` reaches it.
 */
/** How many times any activation of `run` reached the checkpoint `label`. */
export const checkpointsReached = (run: string, label: string): number =>
  checkpoints.get(holdKey(run, label, 0)) ?? 0;

export const checkpoint = async (
  run: string,
  label: string
): Promise<number> => {
  const reached = (checkpoints.get(holdKey(run, label, 0)) ?? 0) + 1;
  checkpoints.set(holdKey(run, label, 0), reached);
  const entry = holds.get(holdKey(run, label, reached));
  if (entry !== undefined) {
    entry.held.resolve(true);
    await entry.release.promise;
  }
  return reached;
};

/** An effect from outside any step: a definition's own catch or finally. */
export const witness = (run: string, label: string): void => {
  effects.push({
    run,
    label,
    key: "",
    attempt: 0,
    receipt: "",
    at: Date.now(),
  });
};

/**
 * The clock the run objects measure an attempt's running time on
 * (`WorkflowRun.clock`): the real one, plus whatever a test's code has
 * moved it on by. Only ever forward, so every other measure stays true.
 */
const clockOffset = { ms: 0 };

export const measuredClock = (): number => Date.now() + clockOffset.ms;

/**
 * Code that runs for `ms` without awaiting anything, as the measured clock
 * sees it: a loop on that clock, which moves it on as it goes.
 */
export const busyFor = (ms: number): void => {
  const until = measuredClock() + ms;
  while (measuredClock() < until) {
    clockOffset.ms += 1;
  }
};
