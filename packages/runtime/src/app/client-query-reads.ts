import type { AccessFence } from "./access-fence.ts";
import type { Settled } from "./call-answers.ts";
import { clientError } from "./client-error.ts";
import type { GraspError } from "./client-error.ts";
import { settleRead, wanted, worthRetrying } from "./client-query-entry.ts";
import type { QueryEntry } from "./client-query-entry.ts";
import { observe, waitAfter } from "./client-retry.ts";
import { sleep } from "./client-shared.ts";
import { fences } from "./refusals.ts";
import { submissionBudgetMs } from "./submission-verdict.ts";

/**
 * How often an imperative read tries before it gives up; one refused for
 * the request budget tries for as long as a submission would
 * (`submissionBudgetMs`), waiting as each refusal says.
 */
const imperativeAttempts = 5;

/** How many queries read at once: the rest wait, keeping room for saves. */
const maxReadsInFlight = 4;

/** Reads queries from the host, a few at once, joining a read under way. */
export class QueryReader {
  readonly #fence: AccessFence;
  /** Reads under way, and the reads waiting for room (`maxReadsInFlight`). */
  #readsInFlight = 0;
  readonly #readWaiters: (() => void)[] = [];

  constructor(fence: AccessFence) {
    this.#fence = fence;
  }

  /**
   * Reads `entry` for an imperative caller: a read under way that a change
   * confirmed since may not see is waited out first, so the answer is of
   * after every change this client confirmed before the call.
   */
  async readCurrent(entry: QueryEntry): Promise<unknown> {
    if (entry.reading !== undefined && entry.stale) {
      await observe(entry.reading.done);
    }
    return await this.#read(entry);
  }

  /**
   * Reads `entry` from the host, joining a read already under way:
   * resolves with its value, or rejects with why it failed. The answer
   * is shown to its readers unless a newer one is, or a fence came
   * between. A lost response is read again, for as long as a component
   * reads the query, or a few times for an imperative read alone. A
   * change confirmed while it was under way reads it again after.
   */
  async #read(entry: QueryEntry): Promise<unknown> {
    if (entry.reading !== undefined) {
      return await entry.reading.done;
    }
    entry.sent += 1;
    const number = entry.sent;
    const { changes } = entry;
    const { generation } = this.#fence;
    const stop = new AbortController();
    const { request } = entry;
    /** Why the read stops early: a fence came between, or no one waits. */
    const interrupted = (): GraspError | undefined => {
      if (generation !== this.#fence.generation) {
        return this.#fence.fencedBy ?? clientError("query.cancelled");
      }
      return stop.signal.aborted ? clientError("query.cancelled") : undefined;
    };
    const attempt = async (): Promise<unknown> => {
      const started = Date.now();
      for (let tries = 1; ; tries += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one attempt after another
        const release = await this.#readRoom(stop.signal);
        let settled: Settled;
        try {
          const early = interrupted();
          if (early !== undefined) {
            throw early;
          }
          // oxlint-disable-next-line no-await-in-loop -- one attempt after another
          settled = await this.#fence.call(request, generation);
        } finally {
          release();
        }
        if (settled.kind === "failed" && fences(settled.error.code)) {
          // The fence showed it to every reader already.
          throw settled.error;
        }
        const stopped = interrupted();
        if (stopped !== undefined) {
          throw stopped;
        }
        const waitingForBudget =
          settled.kind === "failed" &&
          settled.error.code === "page.rate_limited" &&
          Date.now() - started < submissionBudgetMs;
        const keepTrying =
          entry.listeners.size > 0 ||
          tries < imperativeAttempts ||
          waitingForBudget;
        if (!worthRetrying(settled) || !keepTrying || !wanted(entry)) {
          return settleRead(entry, { number, changes }, settled);
        }
        // oxlint-disable-next-line no-await-in-loop -- one attempt after another
        await sleep(waitAfter(settled, tries), stop.signal);
        const late = interrupted();
        if (late !== undefined) {
          throw late;
        }
      }
    };
    const done = attempt();
    entry.reading = { done, stop };
    try {
      return await done;
    } finally {
      if (entry.reading?.done === done) {
        entry.reading = undefined;
      }
    }
  }

  /**
   * Waits for room among the reads under way (`maxReadsInFlight`), or
   * until `signal` aborts: what it answers gives the room back.
   */
  async #readRoom(signal: AbortSignal): Promise<() => void> {
    while (this.#readsInFlight >= maxReadsInFlight && !signal.aborted) {
      const { promise, resolve } = Promise.withResolvers<null>();
      const wake = (): void => {
        resolve(null);
      };
      this.#readWaiters.push(wake);
      signal.addEventListener("abort", wake, { once: true });
      try {
        // oxlint-disable-next-line no-await-in-loop -- one wait after another
        await promise;
      } finally {
        signal.removeEventListener("abort", wake);
        const waiting = this.#readWaiters.indexOf(wake);
        if (waiting !== -1) {
          this.#readWaiters.splice(waiting, 1);
        }
      }
    }
    this.#readsInFlight += 1;
    let given = false;
    return () => {
      if (!given) {
        given = true;
        this.#readsInFlight -= 1;
        this.#readWaiters.shift()?.();
      }
    };
  }
}
