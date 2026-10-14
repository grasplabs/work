// How much one caller's call of an App function may run, as core's operation
// host counts it (operations.ts, store-reader.ts), in a module of its own so
// the on-prem sandbox host bounds a session by the same numbers.

/**
 * The most functions one call may run nested in its own, at any depth:
 * past it, `operation.call_limit`. With `callMaxDepth`, it keeps one
 * action call from fanning out into thousands of invocations.
 */
export const callMaxNested = 64;

/** How many times a query operation runs again before it gives up. */
export const queryMaxReruns = 3;

/**
 * The most runs of App code one call makes in its sandbox session: the
 * function the caller named and every function it may nest, each run
 * once and then again as many times as a run with stale reads is (a
 * query's reruns, a mutation's next attempts).
 */
export const sessionMaxRuns = (1 + callMaxNested) * (1 + queryMaxReruns);
