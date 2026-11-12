import type {
  RecallOverview,
  SearchWay,
  WayCounts,
  WithoutMeaningReason,
} from "./contract.ts";

// What staff see of recall (contract.ts `RecallOverview`): per way, how
// many recalls searched by it, how many it failed and how long it took in
// all; and how many recalls the host made without the question's vector,
// by why. In memory, as the tick's failed steps are: gone with the
// instance, which is what "since" says. No metrics system and no table:
// the store would write a row on every recall for figures staff read
// rarely, and a restart losing them loses nothing anyone acts on.
//
// A mean (total over count) and no buckets: each way's work is bounded
// (`recallLimit`, `exactCandidatesMax`, the vector scan's limit), and what
// staff ask of this is whether a way is slow or failing, not the shape of
// its tail; a spike shows as a mean that moved.
//
// Times are the store's clock around each way's synchronous work, with no
// await added. A runtime whose clock moves only with I/O (as Cloudflare's
// does against timing attacks) may read that work as no time at all: the
// counts hold regardless.

/**
 * Runs one way of a recall: counted, timed and, should it throw, counted
 * as failed and thrown on. Synchronous, as recall is.
 */
export type WayRunner = <T>(way: SearchWay, run: () => T) => T;

/** A way that hasn't run yet. */
const unused = (): WayCounts => ({ recalls: 0, failed: 0, totalMs: 0 });

/**
 * Counts from nothing, since now. Every way and reason named here: one
 * the contract adds fails to compile until it is.
 */
export const newRecallCounts = (): RecallOverview => ({
  since: new Date(),
  ways: { words: unused(), exact: unused(), meaning: unused() },
  withoutMeaning: { timed_out: 0, failed: 0, refused: 0, unusable: 0 },
});

/** A runner that counts into `counts`, timed by the store's own clock. */
export const countingInto =
  (counts: RecallOverview): WayRunner =>
  (way, run) => {
    const counted = counts.ways[way];
    counted.recalls += 1;
    const began = performance.now();
    try {
      return run();
    } catch (error) {
      counted.failed += 1;
      throw error;
    } finally {
      counted.totalMs += performance.now() - began;
    }
  };

/** A recall the host made without the question's vector, for `reason`. */
export const countWithoutMeaning = (
  counts: RecallOverview,
  reason: WithoutMeaningReason
): void => {
  counts.withoutMeaning[reason] += 1;
};

/** `counts` as the overview returns them: a copy, so no caller holds them. */
export const recallOverviewOf = (counts: RecallOverview): RecallOverview =>
  structuredClone(counts);
