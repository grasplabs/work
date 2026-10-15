import type { Json } from "@grasp-os/shared/json";
import { RpcTarget } from "cloudflare:workers";

import type { Settled } from "./code.ts";

/** What an attempt's calls reach in its run host (resource-host.ts). */
export interface AttemptCalls {
  evaluate: (slot: unknown, frame: unknown) => Promise<Settled<Json>>;
  check: (which: unknown, value: unknown) => Settled<null>;
}

/**
 * The host of one attempt of a step in a run of an independent workflow
 * (resource-host.ts), passed to the step's function in the run's isolate:
 * it evaluates the step's own expressions and checks its task's data
 * against the task's own schemas, and nothing else. Every check is its run
 * host's.
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
}
