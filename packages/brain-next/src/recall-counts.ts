import type {
  RecallOverview,
  SearchWay,
  WayCounts,
  WithoutMeaningReason,
} from "./contract.ts";

// What staff see of recall (contract.ts `RecallOverview`): per way, how
// many recalls searched by it and how many it failed; and how many
// recalls the host made without the question's vector, by why. In memory,
// as the tick's failed steps are: gone with the instance, which is what
// "since" says. No metrics system and no table: the store would write a
// row on every recall for figures staff read rarely, and a restart losing
// them loses nothing anyone acts on.
//
// No times: on Cloudflare a Durable Object's clock moves only with I/O,
// and recall here is synchronous, so a time taken around a way would read
// 0 ms in production. Only the caller, across its call to the store, sees
// a clock that moves, and then for the whole recall, not per way
// (GRA-1800).

/**
 * Runs one way of a recall: counted and, should it throw, counted
 * as failed and thrown on. Synchronous, as recall is.
 */
export type WayRunner = <T>(way: SearchWay, run: () => T) => T;

/** A way that hasn't run yet. */
const unused = (): WayCounts => ({ recalls: 0, failed: 0 });

/**
 * Counts from nothing, since now. Every way and reason named here: one
 * the contract adds fails to compile until it is.
 */
export const newRecallCounts = (): RecallOverview => ({
  since: new Date(),
  ways: { words: unused(), exact: unused(), meaning: unused() },
  withoutMeaning: { timed_out: 0, failed: 0, refused: 0, unusable: 0 },
});

/** A runner that counts into `counts`. */
export const countingInto =
  (counts: RecallOverview): WayRunner =>
  (way, run) => {
    const counted = counts.ways[way];
    counted.recalls += 1;
    try {
      return run();
    } catch (error) {
      counted.failed += 1;
      throw error;
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
