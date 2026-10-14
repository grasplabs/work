// One caller's call of an App function, as every function it runs shares
// it (operations.ts `Run.call`), and as its runner sees it: on-prem, the
// sandbox session the function the caller named runs in keeps open until
// every function nested in it has settled (app-functions.ts).

/**
 * The nested calls one caller's call has started and not yet settled,
 * each from the moment the operation host starts it, before it's
 * authorized or reaches its runner.
 */
export class CallTree {
  readonly #started = new Set<Promise<unknown>>();

  /**
   * The sandbox session, by its call ID, of a call this one was made from
   * (a Code Mode run's, for an App function it calls): the session this
   * call's functions run in is its child, which the supervisor gives a
   * process of the parent's own reserve, so it never waits for one the
   * parent holds while the parent waits for it.
   */
  readonly parentSession: string | undefined;

  constructor(parentSession?: string) {
    this.parentSession = parentSession;
  }

  /** Counts `work`, a nested call just started, until it settles. */
  track(work: Promise<unknown>): void {
    this.#started.add(work);
    void this.#forget(work);
  }

  /** Forgets `work` once it settled; never rejects. */
  async #forget(work: Promise<unknown>): Promise<void> {
    try {
      await work;
    } catch {
      // How it failed is its caller's to hear: here, only that it settled.
    } finally {
      this.#started.delete(work);
    }
  }

  /** Whether no nested call it started is still running. */
  idle(): boolean {
    return this.#started.size === 0;
  }

  #session: Promise<unknown> | undefined;

  /**
   * Keeps `session`, the sandbox session its functions run in, which goes
   * on after the function its caller named answered (app-functions.ts).
   */
  holdSession(session: Promise<unknown>): void {
    this.#session = session;
  }

  /**
   * Waits up to `ms` for its sandbox session to end, if it has one: a run
   * given up on frees its process then, which a request that ends with the
   * answer might never get to ask.
   */
  async sessionEnded(ms: number): Promise<void> {
    if (this.#session === undefined) {
      return;
    }
    const session = this.#session;
    const waited = new AbortController();
    await Promise.race([
      (async () => {
        try {
          await session;
        } catch {
          // How it ended is its caller's to hear.
        }
      })(),
      (async () => {
        try {
          await scheduler.wait(ms, { signal: waited.signal });
        } catch {
          // Ended first.
        }
      })(),
    ]);
    waited.abort();
  }

  /** Settles once every nested call started, those they start too, has. */
  async settled(): Promise<void> {
    while (this.#started.size > 0) {
      // oxlint-disable-next-line no-await-in-loop -- until none is left
      await Promise.allSettled(this.#started);
    }
  }
}

/** How a runner is told which call a function runs in. */
export interface RunnerCall {
  readonly tree: CallTree;
  /** Whether the function is nested in another of the call's. */
  readonly nested: boolean;
}
