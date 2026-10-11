import { whenAborted } from "@grasp-os/shared/deadline";

import type { OutboxConsumer } from "../src/outbox-delivery.ts";

/** How long a test waits on a hand-over it expects (`gatedConsumer`). */
const enteredWithinMs = 5000;

/** A consumer gated by a test, as `gatedConsumer` makes it. */
export interface GatedConsumer {
  /** The IDs it was handed, in order. */
  handed: string[];
  consumer: OutboxConsumer;
  /**
   * Waits, in real time and at most `enteredWithinMs`, until its `n`th
   * hand-over began: a test moves a faked clock only once the hand-over
   * it means is going.
   */
  entered: (n: number) => Promise<void>;
  /** Lets any hand-over still waiting go. */
  release: () => void;
}

/**
 * An outbox consumer whose hand-overs answer only once their time is up,
 * or once the test lets them go (`release`): each fails at its limit, and
 * is put back for later.
 */
export const gatedConsumer = (): GatedConsumer => {
  const handed: string[] = [];
  const began: PromiseWithResolvers<null>[] = [];
  const gate = Promise.withResolvers<null>();
  const beganAt = (n: number): PromiseWithResolvers<null> => {
    began[n] ??= Promise.withResolvers<null>();
    return began[n];
  };
  return {
    handed,
    consumer: async (entry) => {
      beganAt(handed.length).resolve(null);
      handed.push(entry.id);
      try {
        await Promise.race([whenAborted(entry.signal), gate.promise]);
      } catch {
        // Its time is up: the drain has given up on it already.
      }
      return "delivered";
    },
    entered: async (n) => {
      // Cancels the bound once the hand-over began, so no wait outlives it.
      const bound = new AbortController();
      const late = async (): Promise<never> => {
        await scheduler.wait(enteredWithinMs, { signal: bound.signal });
        throw new Error(`Hand-over ${n} never began.`);
      };
      try {
        await Promise.race([beganAt(n).promise, late()]);
      } finally {
        bound.abort();
      }
    },
    release: () => {
      gate.resolve(null);
    },
  };
};
