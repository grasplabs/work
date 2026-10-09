/** A call waiting its turn: let in, or given up on once its deadline passes. */
interface Waiter {
  letIn: () => void;
  giveUp: () => void;
}

/**
 * Lets one call into an App run at a time, and the next ones wait their
 * turn in the order they came (`App.call`, app.ts). The App's code runs in
 * one isolate shared by every call, so any of its code can use any caller
 * token it has seen while that token's call runs: with one call at a time,
 * the only live token is the running call's own.
 *
 * A waiter gives up once its deadline passes, and is never let in after;
 * past `limit` waiting, a call is refused at once. Both are the caller's
 * to retry (`busy`). Each turn ends by its `release`, which hands the App
 * to the next waiter, or frees it: called more than once, only the first
 * counts.
 */
export class CallQueue {
  /** Whether a call holds the App now. */
  #held = false;

  /** Who waits, oldest first. */
  readonly #waiting = new Set<Waiter>();

  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  /**
   * Waits for the App, then answers the `release` that ends the turn.
   * Rejects with `busy()` once `signal` aborts first, or at once when the
   * queue is full; either way, the caller never held the App.
   */
  async turn(signal: AbortSignal, busy: () => Error): Promise<() => void> {
    if (!this.#held) {
      this.#held = true;
      return this.#releaser();
    }
    if (signal.aborted || this.#waiting.size >= this.#limit) {
      throw busy();
    }
    const waited = Promise.withResolvers<boolean>();
    // Both run in one turn of the event loop, and each takes the waiter
    // out of the queue first: a waiter that gave up is never let in, and
    // one let in no longer gives up.
    const waiter: Waiter = {
      letIn: () => {
        this.#waiting.delete(waiter);
        signal.removeEventListener("abort", waiter.giveUp);
        waited.resolve(true);
      },
      giveUp: () => {
        this.#waiting.delete(waiter);
        waited.reject(busy());
      },
    };
    this.#waiting.add(waiter);
    signal.addEventListener("abort", waiter.giveUp, { once: true });
    await waited.promise;
    return this.#releaser();
  }

  /** Ends one turn, once: the next waiter's, or nobody's. */
  #releaser(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const [next] = this.#waiting;
      if (next === undefined) {
        this.#held = false;
        return;
      }
      // Still held: the App passes straight to the next waiter, so no call
      // arriving meanwhile can jump the queue.
      next.letIn();
    };
  }
}
