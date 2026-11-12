import type { Producers } from "../src/brain-next.ts";

/**
 * Producers that hand nothing over: for a tick of the Brain whose test is
 * not about hand-overs, which must still say what the tick hands over
 * (brain-next.ts `workBrain`).
 */
export const noProducers: Producers = {
  read: async () => {
    await Promise.resolve();
    return { kind: "gone" };
  },
  settled: async () => {
    await Promise.resolve();
  },
};
