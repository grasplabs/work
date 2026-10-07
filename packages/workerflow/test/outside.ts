import type { WorkflowStepContext } from "../src/contracts.ts";

/** One effect as the outside system received it. */
export interface Effect {
  run: string;
  label: string;
  key: string;
  attempt: number;
  /** What the outside system answered with. */
  receipt: string;
}

/**
 * The outside world the test definitions act on: it records each effect
 * it receives, answers with a receipt, and can withhold the answer to a
 * given attempt (the effect happened; the step hasn't heard back). The
 * test and the run objects share this module's state: the Workers pool
 * runs the main Worker's objects in the test's isolate.
 */
export const effects: Effect[] = [];

const holds = new Map<
  string,
  {
    held: PromiseWithResolvers<true>;
    release: PromiseWithResolvers<true>;
  }
>();

const holdKey = (run: string, label: string, attempt: number): string =>
  JSON.stringify([run, label, attempt]);

/**
 * Withholds the answer to `label`'s `attempt` in `run`. `held` resolves once
 * the effect arrived; the answer goes out on `release()`.
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
  return {
    held: entry.held.promise,
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
  });
  const entry = holds.get(holdKey(run, label, context.attempt));
  if (entry !== undefined) {
    entry.held.resolve(true);
    await entry.release.promise;
  }
  return receipt;
};

const checkpoints = new Map<string, number>();

/**
 * A wait in a definition outside any step (nothing journaled), which the
 * test can withhold like an effect's answer: `hold(run, label, n)` holds
 * the n-th time any activation of `run` reaches it.
 */
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
  effects.push({ run, label, key: "", attempt: 0, receipt: "" });
};
