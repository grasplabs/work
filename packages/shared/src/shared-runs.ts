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
// one per waiter. The abandoned entry keeps a link to its replacement, so
// a waiter whose time runs out after the replacement already finished
// still shares it rather than starting another. An abandoned entry no one
// asks for again would stay for the isolate's life, so every call first
// drops the entries long past their own time (`pruneAbandoned`): the map
// holds no more than the work that may still be running or waited on.

/** One request's work, as the others see it. */
export interface SharedRun<T> {
  readonly promise: Promise<T>;
  /** When it started, by `Date.now()`. */
  readonly started: number;
  /** How long it may take, from its start, before it is taken for abandoned. */
  readonly abandonAfterMs: number;
  /** The work that took its place once it was taken for abandoned. */
  replacedBy?: SharedRun<T>;
}

/**
 * How often a request waiting on another's work looks whether it settled:
 * soon at first, as most shared work is nearly done when it is asked for,
 * then less often, never past {@link lookMostMs}.
 */
const lookFirstMs = 5;
const lookMostMs = 100;

/** Waits `ms` on a timer of the calling request's own. */
const pause = async (ms: number): Promise<void> => {
  // oxlint-disable-next-line promise/avoid-new -- a timer has no promise form in every runtime this package runs in
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

/**
 * What `running` settles with within `ms`, or `elapsed` once `ms` passed
 * first; its rejection, if it rejects first.
 *
 * `running` is another request's work, and workerd can run a promise's
 * continuations in the request that settled it. Awaited here, the rest of
 * this request (an activation of one workflow run, say, sharing another
 * run's build) would go on in the other's: as one Durable Object, its
 * storage calls on another object's behalf, which workerd refuses ("Cannot
 * perform I/O on behalf of a different Durable Object"), and its RPC calls
 * the other's, whose answers land there. So the work's outcome is only
 * noted where it settles, and this request goes on from a timer of its
 * own once it sees it.
 */
const settledWithin = async <T>(
  running: Promise<T>,
  ms: number
): Promise<{ value: T } | "elapsed"> => {
  const seen: { outcome?: { value: T } | { error: unknown } } = {};
  // Noted where it settles, run in the request that settles it: nothing
  // more than that, so nothing of this request's runs there. Not awaited,
  // for that reason; it never rejects.
  const note = async (): Promise<void> => {
    try {
      seen.outcome = { value: await running };
    } catch (error) {
      seen.outcome = { error };
    }
  };
  void note();
  const endsAt = Date.now() + ms;
  let lookMs = lookFirstMs;
  while (seen.outcome === undefined) {
    const left = endsAt - Date.now();
    if (left <= 0) {
      return "elapsed";
    }
    // One look after the other, each on this request's own timer.
    // oxlint-disable-next-line no-await-in-loop
    await pause(Math.min(lookMs, left));
    lookMs = Math.min(lookMs * 2, lookMostMs);
  }
  const { outcome } = seen;
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome;
};

/**
 * How many times its own time an entry is kept: past its time it is
 * abandoned, and its waiters leave it when theirs runs out, which is then
 * too, to follow its link to the replacement. Kept a while longer, so a
 * waiter whose timer fired but hasn't run yet still finds the link rather
 * than an empty slot, and starts no second replacement. A waiter's count
 * couldn't say when they all left: one whose request was cancelled never
 * leaves.
 */
const keptForTimes = 2;

/**
 * Drops from `runs` every entry long past its own time
 * ({@link keptForTimes}), other than `key`'s, which the caller handles
 * itself. Each is abandoned and no longer waited on. Its own `finally`,
 * should it ever run, deletes only an entry that is still its own.
 */
const pruneAbandoned = <T>(
  runs: Map<string, SharedRun<T>>,
  key: string,
  now: number
): void => {
  for (const [other, run] of runs) {
    if (
      other !== key &&
      run.started + keptForTimes * run.abandonAfterMs <= now
    ) {
      runs.delete(other);
    }
  }
};

/**
 * What `start` answers, or what the same work already running for `key`
 * in `runs` answers once it does: within `abandonAfterMs` of its start,
 * else the work that took its place, started by `start` here if no other
 * waiter started it first. The entry goes once its work settled; one
 * whose request was cancelled goes once a later call, for any key, finds
 * it long abandoned. Given up on (`signal`) by the time it would start its own,
 * it starts none, and takes no one's place: whoever waits besides it
 * starts the replacement.
 */
export const sharedRun = async <T>(
  runs: Map<string, SharedRun<T>>,
  key: string,
  abandonAfterMs: number,
  start: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> => {
  pruneAbandoned(runs, key, Date.now());
  let running = runs.get(key);
  let replaced: SharedRun<T> | undefined;
  while (running !== undefined) {
    const left = running.started + abandonAfterMs - Date.now();
    // One wait after the other: each on the work running now.
    const settled =
      // oxlint-disable-next-line no-await-in-loop
      left > 0 ? await settledWithin(running.promise, left) : "elapsed";
    if (settled !== "elapsed") {
      return settled.value;
    }
    if (running.replacedBy === undefined) {
      // Abandoned, and found so first here: this request replaces it.
      replaced = running;
      break;
    }
    // Another waiter replaced it already, finished or not: share that.
    running = running.replacedBy;
  }
  // Given up on while it waited: it starts nothing, and leaves the
  // abandoned work for another waiter to replace.
  signal?.throwIfAborted();
  const run: SharedRun<T> = {
    promise: start(),
    started: Date.now(),
    abandonAfterMs,
  };
  if (replaced !== undefined) {
    replaced.replacedBy = run;
  }
  runs.set(key, run);
  try {
    return await run.promise;
  } finally {
    if (runs.get(key) === run) {
      runs.delete(key);
    }
  }
};
