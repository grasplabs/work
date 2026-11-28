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
//
// No request awaits another's promise. The request whose work it is notes
// how it ended on the entry, and the others read that on timers of their
// own. A promise is settled only in the request that made it, so awaited
// from another its continuations ran there; and since workerd
// 1.20261113.1, an await of one whose request ended rejects at once ("can
// never settle"), which a waiter would have taken for the work's failure.

/** How a request's work ended: its answer, or what it threw. */
type Outcome<T> = { readonly value: T } | { readonly error: unknown };

/** One request's work, as the others see it. */
export interface SharedRun<T> {
  /** When it started, by `Date.now()`. */
  readonly started: number;
  /** How long it may take, from its start, before it is taken for abandoned. */
  readonly abandonAfterMs: number;
  /** How it ended, noted by the request whose work it is. */
  outcome?: Outcome<T>;
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
 * What another request's work (`running`) noted it ended with within `ms`,
 * or `elapsed` once `ms` passed first; what it threw, if it failed first.
 * Read on this request's own timer, never by awaiting the other's promise
 * (see above): the rest of this request (an activation of one workflow
 * run, say, sharing another run's build) then never goes on in the other's,
 * where, as one Durable Object, its storage calls would be on another
 * object's behalf, which workerd refuses ("Cannot perform I/O on behalf of
 * a different Durable Object"), and its RPC calls the other's.
 */
const settledWithin = async <T>(
  running: { readonly outcome?: Outcome<T> },
  ms: number
): Promise<{ value: T } | "elapsed"> => {
  const endsAt = Date.now() + ms;
  let lookMs = lookFirstMs;
  for (;;) {
    const { outcome } = running;
    if (outcome !== undefined) {
      if ("error" in outcome) {
        throw outcome.error;
      }
      return outcome;
    }
    const left = endsAt - Date.now();
    if (left <= 0) {
      return "elapsed";
    }
    // One look after the other, each on this request's own timer.
    // oxlint-disable-next-line no-await-in-loop
    await pause(Math.min(lookMs, left));
    lookMs = Math.min(lookMs * 2, lookMostMs);
  }
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
      left > 0 ? await settledWithin(running, left) : "elapsed";
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
  const work = start();
  const run: SharedRun<T> = { started: Date.now(), abandonAfterMs };
  if (replaced !== undefined) {
    replaced.replacedBy = run;
  }
  runs.set(key, run);
  try {
    const value = await work;
    run.outcome = { value };
    return value;
  } catch (error) {
    run.outcome = { error };
    throw error;
  } finally {
    if (runs.get(key) === run) {
      runs.delete(key);
    }
  }
};

/** A turn of `inTurn`. */
interface Turn {
  /** When it is due to end, by `Date.now()`: past it, it is taken for abandoned. */
  readonly endsBy: number;
  /**
   * The turn before it, kept while it waits, so that once it gives up the
   * turns after it wait for that one instead.
   */
  before?: Turn;
  /** How it ended: it ran, or it gave up waiting before its turn came. */
  ended?: "ran" | "gave up";
}

/** Work of an isolate's requests that runs one at a time (`inTurn`): its last turn. */
export interface Turns {
  last?: Turn;
}

/**
 * The turn one after `turn` waits for: `turn`, or, past the turns that
 * gave up, the last one before them that didn't.
 */
const waitedFor = (turn: Turn | undefined): Turn | undefined => {
  let at = turn;
  while (at?.ended === "gave up") {
    at = at.before;
  }
  return at;
};

/** Whether `turn` is over: it ran, or its time is up (a cancelled request's never ends). */
const over = (turn: Turn, now: number): boolean =>
  turn.ended === "ran" || turn.endsBy <= now;

/**
 * How many turns of `turns` are waiting or running now: none that ran,
 * gave up or whose time is up.
 */
export const turnsUnderWay = (turns: Turns): number => {
  const now = Date.now();
  let count = 0;
  for (
    let at = waitedFor(turns.last);
    at !== undefined && !over(at, now);
    at = waitedFor(at.before)
  ) {
    count += 1;
  }
  return count;
};

/**
 * What `start` answers, started once every earlier turn of `turns` ended,
 * or was taken for abandoned: each turn may take `turnMs` from when the
 * one before it was due to end, as a cancelled request's turn never ends
 * (see above). For work that must never overlap within an isolate, such
 * as reads that each hold a large part of its memory. With `until`, a turn
 * that hasn't come by `until.at` gives up with `until.error()`, and the
 * turns after it wait for the one before it: giving up never lets one
 * run beside a turn still running.
 */
export const inTurn = async <T>(
  turns: Turns,
  turnMs: number,
  start: () => Promise<T>,
  until?: { readonly at: number; readonly error: () => Error }
): Promise<T> => {
  const before = waitedFor(turns.last);
  const turn: Turn = {
    before,
    endsBy: Math.max(Date.now(), before?.endsBy ?? 0) + turnMs,
  };
  turns.last = turn;
  // Its turn comes once the one it waits for is over, on this request's
  // own timer: never by awaiting another request's promise.
  let lookMs = lookFirstMs;
  for (
    let waited = waitedFor(turn.before);
    waited !== undefined && !over(waited, Date.now());
    waited = waitedFor(turn.before)
  ) {
    const now = Date.now();
    if (until !== undefined && until.at <= now) {
      turn.ended = "gave up";
      if (turns.last === turn) {
        turns.last = turn.before;
      }
      throw until.error();
    }
    const left = Math.min(
      waited.endsBy - now,
      (until?.at ?? Number.POSITIVE_INFINITY) - now
    );
    // One look after the other, each on this request's own timer.
    // oxlint-disable-next-line no-await-in-loop
    await pause(Math.min(lookMs, left));
    lookMs = Math.min(lookMs * 2, lookMostMs);
  }
  turn.before = undefined;
  try {
    return await start();
  } finally {
    turn.ended = "ran";
    if (turns.last === turn) {
      turns.last = undefined;
    }
  }
};
