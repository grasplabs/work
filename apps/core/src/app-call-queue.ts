/** A call waiting its turn: let in, or given up on. */
interface Waiter<Tag> {
  /** What the call waiting says of itself (`CallQueue.waitingTags`). */
  tag: Tag | undefined;
  letIn: () => void;
  /** Gives up as its deadline passed, with the call's `busy()`. */
  giveUp: () => void;
  /** Gives up with `refusal`, as its `Wait.check` found. */
  refuse: (refusal: Error) => void;
}

/**
 * What a call says as it waits: `tag`, which `CallQueue.waitingTags`
 * shows while it waits, and `check`, asked once it waits, whose error, if
 * any, refuses the call at once, unless it was let in meanwhile.
 */
export interface Wait<Tag> {
  tag: Tag;
  check: () => Promise<Error | undefined>;
}

/** Refuses `waiter` with what `check` finds, unless let in by then. */
const refuseIfFound = async <Tag>(
  waiter: Waiter<Tag>,
  check: () => Promise<Error | undefined>
): Promise<void> => {
  let refusal: Error | undefined;
  try {
    refusal = await check();
  } catch {
    // A check that fails finds nothing: the call waits as any other.
    return;
  }
  // A waiter let in meanwhile no longer gives up (`CallQueue.turn`).
  if (refusal !== undefined) {
    waiter.refuse(refusal);
  }
};

/**
 * Lets one call into an App run at a time, and the next ones wait their
 * turn in the order they came (`App.call`, app.ts). The App's code runs in
 * one isolate shared by every call, so any of its code can use any caller
 * token it has seen while that token's call runs: with one call at a time,
 * the only live token is the running call's own. A turn lasts until the
 * call's code settled, not only until its caller had an answer (see
 * `App.call`). Work the App's code leaves running detached from its call
 * (a promise it doesn't await, a timer) isn't held to the turn, and can
 * still use a later call's token: never more than that App's own code
 * may. Only an isolate per call closes that.
 *
 * A waiter gives up once its deadline passes, or once its `Wait.check`
 * finds a reason to, and is never let in after; past `limit` waiting, a
 * call is refused at once. All are the caller's to retry. Each turn ends
 * by its `release`, which hands the App to the next waiter, or frees it:
 * called more than once, only the first counts.
 */
export class CallQueue<Tag = never> {
  /** Whether a call holds the App now. */
  #held = false;

  /** Who waits, oldest first. */
  readonly #waiting = new Set<Waiter<Tag>>();

  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** How many calls wait now. */
  waiting(): number {
    return this.#waiting.size;
  }

  /** What the calls waiting now say of themselves (`Wait.tag`), oldest first. */
  waitingTags(): Tag[] {
    return [...this.#waiting].flatMap(({ tag }) =>
      tag === undefined ? [] : [tag]
    );
  }

  /**
   * Waits for the App, then answers the `release` that ends the turn.
   * Rejects with `busy()` once `signal` aborts first, or at once when the
   * queue is full, or with what `wait.check` finds once the call waits;
   * either way, the caller never held the App.
   */
  async turn(
    signal: AbortSignal,
    busy: () => Error,
    wait?: Wait<Tag>
  ): Promise<() => void> {
    if (!this.#held) {
      this.#held = true;
      return this.#releaser();
    }
    if (signal.aborted || this.#waiting.size >= this.#limit) {
      throw busy();
    }
    const waited = Promise.withResolvers<boolean>();
    // Made before anything can call for it, so giving up only rejects.
    const timedOut = busy();
    // Each runs in one turn of the event loop, and takes the waiter out
    // of the queue first: a waiter that gave up is never let in, and one
    // let in no longer gives up.
    const waiter: Waiter<Tag> = {
      tag: wait?.tag,
      letIn: () => {
        this.#waiting.delete(waiter);
        signal.removeEventListener("abort", waiter.giveUp);
        waited.resolve(true);
      },
      giveUp: () => {
        waiter.refuse(timedOut);
      },
      refuse: (refusal) => {
        this.#waiting.delete(waiter);
        signal.removeEventListener("abort", waiter.giveUp);
        waited.reject(refusal);
      },
    };
    this.#waiting.add(waiter);
    signal.addEventListener("abort", waiter.giveUp, { once: true });
    // Asked only once the call waits, where `waitingTags` shows it: of
    // two calls that each check for the other, the later finds the
    // earlier.
    if (wait !== undefined) {
      void refuseIfFound(waiter, wait.check);
    }
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
