import type { Producers } from "../src/brain-next.ts";

/**
 * Producers that hand nothing over: for a tick of the Brain whose test is
 * not about hand-overs, which must still say what the tick hands over
 * (brain-next.ts `workBrain`). Each attempt finds its source gone and
 * records nothing.
 */
export const noProducers: Producers = {
  attempt: async () =>
    await Promise.resolve({
      handed: { kind: "gone", skipped: "deleted" },
      started: async () => await Promise.resolve(false),
      ended: async () => {
        await Promise.resolve();
      },
    }),
};
