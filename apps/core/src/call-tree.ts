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
