import { readAnswer, readRejection } from "./call-answers.ts";
import type { Settled } from "./call-answers.ts";
import { clientError } from "./client-error.ts";
import type { GraspError } from "./client-error.ts";
import type { ClientTransport } from "./client-transport.ts";
import { fencingRefusalOf } from "./refusals.ts";

/**
 * The client's fence: the generation every request begins under, which
 * moves on whenever the person or the build loses access, and the one
 * call through the transport that a refusal of either fences.
 */
export class AccessFence {
  readonly #transport: ClientTransport;
  /** Clears what the client holds, at a fence, before its listeners hear. */
  readonly #clear: (refusal: GraspError) => void;
  /** Moves on at every fence: answers to older requests are dropped. */
  #generation = 0;
  /** What the latest fence was for. */
  #fencedBy: GraspError | undefined;
  /** Told of every fence (`WorkflowLink.onFence`). */
  readonly #fenceListeners = new Set<(refusal: GraspError) => void>();

  constructor(
    transport: ClientTransport,
    clear: (refusal: GraspError) => void
  ) {
    this.#transport = transport;
    this.#clear = clear;
  }

  /** The fence generation now: what a request begins under. */
  get generation(): number {
    return this.#generation;
  }

  /** What the latest fence was for, if there was one. */
  get fencedBy(): GraspError | undefined {
    return this.#fencedBy;
  }

  /** Calls `listener` at every fence; answers what stops calling it. */
  onFence(listener: (refusal: GraspError) => void): () => void {
    this.#fenceListeners.add(listener);
    return () => {
      this.#fenceListeners.delete(listener);
    };
  }

  /**
   * One call through the transport, settled, never thrown. A refusal of
   * the person or the build fences every cache before its caller hears of
   * it. A call begun under a `generation` a fence has moved on from (a
   * retry of a lost answer among them) is refused unsent, as that fence
   * was; it never fences on its own, since that fence cleared already.
   */
  async call(request: string, generation: number): Promise<Settled> {
    if (generation !== this.#generation) {
      return {
        kind: "failed",
        error: this.#fencedBy ?? clientError("auth.principal_changed"),
      };
    }
    let settled: Settled;
    try {
      settled = readAnswer(await this.#transport.call(request));
    } catch (error) {
      settled = readRejection(error);
    }
    // A refusal of a request sent before the latest fence is of who or
    // what that fence already cleared: it doesn't fence whoever came after.
    const fencing =
      settled.kind === "failed" ? fencingRefusalOf(settled.error) : undefined;
    if (generation === this.#generation && fencing !== undefined) {
      this.fence(fencing);
    }
    return settled;
  }

  /** Tells the fence's listeners (`WorkflowLink.onFence`) of `refusal`. */
  #tellFence(refusal: GraspError): void {
    for (const listener of this.#fenceListeners) {
      listener(refusal);
    }
  }

  /**
   * Clears every cached result: the person, or the build, lost access
   * (`refusal` says how). Reads under way are dropped, and every query
   * shows the refusal in place of its data; trying again
   * (`retryFailed`) reads it afresh.
   */
  fence(refusal: GraspError): void {
    this.#generation += 1;
    this.#fencedBy = refusal;
    this.#clear(refusal);
    this.#tellFence(refusal);
  }
}
