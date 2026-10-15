import type { Json } from "@grasp-os/shared/json";
import { RpcTarget } from "cloudflare:workers";

import type { Settled } from "./code.ts";

/**
 * The host of one attempt of a task's step in a run of an independent
 * workflow (resource-host.ts), passed to the step's function in the run's
 * isolate: it evaluates the task's own expressions, and nothing else.
 * Every check is its run host's, which `evaluate` is.
 */
export class ResourceAttemptHost extends RpcTarget {
  readonly #evaluate: (slot: unknown) => Promise<Settled<Json>>;

  constructor(evaluate: (slot: unknown) => Promise<Settled<Json>>) {
    super();
    this.#evaluate = evaluate;
  }

  /** Evaluates expression `slot` of the sealed table, its task's own. */
  async evaluate(slot: unknown): Promise<Settled<Json>> {
    return await this.#evaluate(slot);
  }
}
