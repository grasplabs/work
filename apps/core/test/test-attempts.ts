/**
 * Each attempt of a test, as the work it started knows it. Vitest stops
 * waiting for a test at its timeout, but the test's own promises go on in
 * the runtime the file's later tests share (`isolate: false`): a long pass
 * of the Brain's leak harness, cut off, went on asking the stores while
 * the next test watched which stores were addressed, and failed it. The
 * work a test started runs in its attempt's context (start-each-file.ts
 * wraps each one, `inAttempt`), which ends as the attempt does, however it
 * ends; a helper that reaches shared state asks `stopIfEnded` first, and
 * what a test left going stops there.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** The running attempt's signal, aborted once that attempt ended. */
const attempts = new AsyncLocalStorage<AbortSignal>();

/** Runs `attempt` in a context of its own, ended once it settles. */
export const inAttempt = async (attempt: () => Promise<void>) => {
  const ended = new AbortController();
  try {
    await attempts.run(ended.signal, attempt);
  } finally {
    ended.abort(new Error("The test this work belongs to has ended"));
  }
};

/** Throws once the test whose work this is has ended: outside a test, never. */
export const stopIfEnded = (): void => {
  attempts.getStore()?.throwIfAborted();
};
