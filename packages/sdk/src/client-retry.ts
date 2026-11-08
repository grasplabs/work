import { retryAfterOf } from "./client-error.ts";
import type { GraspError, Settled } from "./client-error.ts";
import { retryDelay } from "./client-shared.ts";

/** The longest a call waits before it is sent again. */
export const retryCapMs = 30_000;

/**
 * How long to wait for a request budget to give back a request, when a
 * refusal as `page.rate_limited` didn't say.
 */
const rateLimitedWaitMs = 1000;

/**
 * How long to wait before attempt `attempt` + 1 after `settled`: a
 * refusal for the request budget waits at least as long as it said (or
 * `rateLimitedWaitMs`), so retries never spend a budget that is empty.
 */
export const waitAfter = (settled: Settled, attempt: number): number => {
  const backoff = retryDelay(attempt, retryCapMs);
  if (settled.kind !== "failed" || settled.error.code !== "page.rate_limited") {
    return backoff;
  }
  const said = retryAfterOf(settled.error.details) ?? rateLimitedWaitMs;
  // As long as the budget takes to give one back, and a little more, so
  // calls refused together don't all ask again at the same moment.
  return said + Math.random() * said;
};

/** Waits for `work` without letting its failure surface unhandled. */
export const observe = async (work: Promise<unknown>): Promise<void> => {
  try {
    await work;
  } catch {
    // Its own caller, if it still has one, hears of it.
  }
};

/**
 * `work`, or `cancelled` as soon as `signal` aborts: only the caller
 * stops waiting, and `work` goes on.
 */
export const waitFor = async <T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  cancelled: () => GraspError
): Promise<T> => {
  if (signal === undefined) {
    return await work;
  }
  void observe(work);
  const { promise, reject } = Promise.withResolvers<never>();
  const onAbort = (): void => {
    reject(cancelled());
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  try {
    return await Promise.race([work, promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};
