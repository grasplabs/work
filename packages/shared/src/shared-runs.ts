import { deadline, whenAborted } from "./deadline.ts";

// Work several requests of one isolate share while it runs (a build of
// the same files, a read of the release's platform code), so it runs once
// rather than once per request. A request's work belongs to that request:
// workerd cancels it, and every continuation it would have run, when the
// request is cancelled (its caller gave up on a service binding or RPC
// call), so its promise never settles and nothing it would have done in a
// `finally` happens. A request that waits on another's work therefore
// waits only as long as that work may take (`abandonAfterMs`, from the
// work's own bounds); past it, the work is taken for abandoned, and the
// first waiter to find it so starts its own in its place, which every
// other waiter, and whoever asks next, then shares: one replacement, not
// one per waiter.

/** One request's work, as the others see it. */
export interface SharedRun<T> {
  readonly promise: Promise<T>;
  /** When it started, by `Date.now()`. */
  readonly started: number;
}

/**
 * What `running` settles with within `ms`, or `elapsed` once `ms` passed
 * first; its rejection, if it rejects first. Its timer goes as soon as
 * either happens.
 */
const settledWithin = async <T>(
  running: Promise<T>,
  ms: number
): Promise<{ value: T } | "elapsed"> => {
  const timer = deadline(ms);
  const elapsed = async (): Promise<"elapsed"> => {
    try {
      await whenAborted(timer.signal);
    } catch {
      // Its time is up.
    }
    return "elapsed";
  };
  try {
    return await Promise.race([
      running.then((value) => ({ value })),
      elapsed(),
    ]);
  } finally {
    timer.clear();
  }
};

/**
 * What `start` answers, or what the same work already running for `key`
 * in `runs` answers once it does: within `abandonAfterMs` of its start,
 * else the work that took its place, started by `start` here if no other
 * waiter started it first. The entry goes once its work settled; one
 * whose request was cancelled stays until the next request finds it
 * abandoned.
 */
export const sharedRun = async <T>(
  runs: Map<string, SharedRun<T>>,
  key: string,
  abandonAfterMs: number,
  start: () => Promise<T>
): Promise<T> => {
  for (;;) {
    const running = runs.get(key);
    if (running === undefined) {
      break;
    }
    const left = running.started + abandonAfterMs - Date.now();
    // One wait after the other: each on the work running now.
    const settled =
      // oxlint-disable-next-line no-await-in-loop
      left > 0 ? await settledWithin(running.promise, left) : "elapsed";
    if (settled !== "elapsed") {
      return settled.value;
    }
    if (runs.get(key) === running) {
      // Abandoned, and found so first here: this request replaces it.
      break;
    }
    // Another waiter replaced it already: wait on that.
  }
  const run: SharedRun<T> = { promise: start(), started: Date.now() };
  runs.set(key, run);
  try {
    return await run.promise;
  } finally {
    if (runs.get(key) === run) {
      runs.delete(key);
    }
  }
};
