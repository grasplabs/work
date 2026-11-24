// A subscription to a run's events, as the run object hands it out over
// RPC: an RpcTarget whose `next` reads the run's history (history.ts) from
// its cursor on, one event a call, and waits for the next write when it
// has read all there is. Nothing is buffered for it: a subscriber that
// reads slowly holds its cursor and nothing else, however far behind it
// is, and one that reconnects after a failure passes the last event ID it
// handled as its cursor and misses nothing. Disposing it (`using`, or
// releasing its stub; workerd does so when the caller's session ends)
// ends a `next` that waits, and every later one is done.
import { RpcTarget } from "cloudflare:workers";

import type { WorkflowInstanceEvent } from "./contracts.ts";

export type SubscriptionResult = IteratorResult<
  WorkflowInstanceEvent,
  undefined
>;

const done: SubscriptionResult = { done: true, value: undefined };

const isTerminal = (event: WorkflowInstanceEvent): boolean =>
  event.type === "workflow_completed" ||
  event.type === "workflow_errored" ||
  event.type === "workflow_terminated";

export class Subscription extends RpcTarget {
  readonly #read: () => Promise<SubscriptionResult>;
  readonly #onClose: () => void;
  /** The `next` calls in flight, answered one after another. */
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  /**
   * Why the subscription ended without the run's end: a read that failed,
   * or a cut-off. Every later call fails with it, so a caller never takes
   * that for the run's end, and subscribes again from its cursor.
   */
  #failure: Error | undefined;

  constructor(read: () => Promise<SubscriptionResult>, onClose: () => void) {
    super();
    this.#read = read;
    this.#onClose = onClose;
  }

  async next(): Promise<SubscriptionResult> {
    // Each call waits for the one before it: events are answered in order,
    // one to a call.
    const before = this.#queue;
    const turn = Promise.withResolvers<boolean>();
    this.#queue = turn.promise;
    try {
      await before;
      return await this.#answer();
    } finally {
      turn.resolve(true);
    }
  }

  async #answer(): Promise<SubscriptionResult> {
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    if (this.#closed) {
      return done;
    }
    let result: SubscriptionResult;
    try {
      result = await this.#read();
    } catch (error) {
      this.#failure = error instanceof Error ? error : new Error(String(error));
      this.#close();
      throw this.#failure;
    }
    if (this.#closed) {
      return done;
    }
    if (result.done === true || isTerminal(result.value)) {
      this.#close();
    }
    return result;
  }

  [Symbol.dispose](): void {
    this.#close();
  }

  #close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#onClose();
  }
}
