import { z } from "zod";

import { sourceIdSchema } from "./contract.ts";
import type { HandOverPriority, HandOverRequest } from "./contract.ts";
import { defineWork, enqueueWork } from "./work.ts";
import type { WorkPriority } from "./work.ts";

// Hand-overs (contract.ts): a source the host produces, put on the shared
// store's work queue by its key alone. Each run asks the host to hand it
// over as its records hold it then; the host adds it through its own way
// of adding, which picks the store its readers belong in, so nothing of it
// is read or written here. The host's answer (`HandOverResult`: added,
// nothing to add, or refused for good) settles the item as done; a host
// that throws fails the attempt: it is tried again after the queue's
// backoff, and parked after too many failures, where staff see it. A newer
// item of the same source, waiting, replaces an older one, and one source
// never has two running.

/** Hand-overs, one kind of work. */
const handOverKind = "source.handover";

/** Each class a hand-over takes is one of the queue's. */
const priorities = {
  conversation: "conversation",
} as const satisfies Record<HandOverPriority, WorkPriority>;

const handOverWork = defineWork({
  kind: handOverKind,
  payload: z.strictObject({ source: sourceIdSchema }),
  run: async ({ source }, { handOvers, signal }) => {
    signal.throwIfAborted();
    if (handOvers === undefined) {
      // A tick without the host's side of hand-overs (a person's own
      // store's, or a host that gave none): tried again on a later one.
      throw new Error("This tick has no side of hand-overs");
    }
    await handOvers.handOver(source);
  },
});

/**
 * Puts each source of `request` on the queue in `storage` to be handed
 * over, in place of one of its hand-overs still waiting or parked.
 */
export const enqueueHandOvers = (
  storage: DurableObjectStorage,
  { items }: HandOverRequest
): void => {
  // Each in a transaction of its own: one put on twice replaces itself.
  for (const { source, priority } of items) {
    enqueueWork(storage, handOverWork, {
      key: source,
      payload: { source },
      priority: priorities[priority],
    });
  }
};
