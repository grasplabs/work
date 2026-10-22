import type { Json } from "@grasp-os/shared/json";
import { RpcTarget } from "cloudflare:workers";

import type { Settled } from "./code.ts";

/** What an attempt's calls reach in its run host (resource-host.ts). */
export interface AttemptCalls {
  evaluate: (slot: unknown, frame: unknown) => Promise<Settled<Json>>;
  check: (which: unknown, value: unknown) => Settled<null>;
  call: (frame: unknown) => Promise<Settled<Json>>;
  until: (frame: unknown) => Promise<Settled<number>>;
  items: (frame: unknown) => Promise<Settled<LoopItems>>;
}

/** A `for` task's items, and their keys where its loop has them. */
export interface LoopItems {
  items: Json[];
  keys?: (string | number)[];
}

/**
 * The host of one attempt of a step in a run of an independent workflow
 * (resource-host.ts), passed to the step's function in the run's isolate:
 * it evaluates the step's own expressions, checks its task's data against
 * the task's own schemas, and makes its task's call or resolves its
 * deadline or its items, and nothing else. Every check, and everything a call is made
 * of, is its run host's.
 */
export class ResourceAttemptHost extends RpcTarget {
  readonly #calls: AttemptCalls;

  constructor(calls: AttemptCalls) {
    super();
    this.#calls = calls;
  }

  /** Evaluates expression `slot` of the sealed table, its step's own. */
  async evaluate(slot: unknown, frame: unknown): Promise<Settled<Json>> {
    return await this.#calls.evaluate(slot, frame);
  }

  /** Checks `value` against the task's `which` schema. */
  check(which: unknown, value: unknown): Settled<null> {
    return this.#calls.check(which, value);
  }

  /** Makes the task's call, as the build sealed it, on its input. */
  async call(frame: unknown): Promise<Settled<Json>> {
    return await this.#calls.call(frame);
  }

  /** Resolves the task's deadline, as the build sealed it, on its input. */
  async until(frame: unknown): Promise<Settled<number>> {
    return await this.#calls.until(frame);
  }

  /**
   * Resolves a `for` task's items, as the build sealed them, on its input,
   * with their keys where its loop has them.
   */
  async items(frame: unknown): Promise<Settled<LoopItems>> {
    return await this.#calls.items(frame);
  }
}
