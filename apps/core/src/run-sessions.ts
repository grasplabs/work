import { operationErrors } from "@grasp-os/shared/operations";

// The sandbox session each Code Mode run holds on-prem, by the run's ID,
// while it's open: an App function the run calls (env.apps.call) runs in
// a child of it, which the supervisor gives a process of the run's own
// reserve, so the call never waits for a process the run holds while the
// run waits for it (scripts/workerd-sandbox.ts). Core's APIs are loopback
// stubs of this Worker, which on-prem runs in one isolate, so the API a
// run calls finds its session here; only its ID crosses, no I/O object.

const sessions = new Map<string, string>();

/** Holds `callId` as run `key`'s session; the returned function lets go. */
export const holdRunSession = (key: string, callId: string): (() => void) => {
  sessions.set(key, callId);
  return () => {
    if (sessions.get(key) === callId) {
      sessions.delete(key);
    }
  };
};

/** The session (its call ID) run `key` holds now, if it holds one. */
export const runSessionOf = (key: string): string | undefined =>
  sessions.get(key);

/** The last call to take its turn, by run: the next waits for it. */
const turns = new Map<string, Promise<void>>();

/**
 * Runs `work` once the calls run `key` made before it have finished, one
 * at a time (no key: at once), or refuses with
 * `operation.deadline_exceeded` if its turn doesn't come by `until`.
 */
export const inTurn = async <T>(
  key: string | undefined,
  until: number,
  work: () => Promise<T>
): Promise<T> => {
  if (key === undefined) {
    return await work();
  }
  const before = turns.get(key) ?? Promise.resolve();
  const { promise: done, resolve: finish } = Promise.withResolvers<true>();
  // Over once the one before it is, and it is: a call that gives up
  // waiting still holds its place until the one before it has finished.
  const mine = (async (): Promise<void> => {
    await before;
    await done;
  })();
  turns.set(key, mine);
  try {
    const waited = new AbortController();
    const turnCame = await Promise.race([
      (async (): Promise<boolean> => {
        await before;
        return true;
      })(),
      (async (): Promise<boolean> => {
        try {
          await scheduler.wait(Math.max(until - Date.now(), 0), {
            signal: waited.signal,
          });
        } catch {
          // Its turn came first.
        }
        return false;
      })(),
    ]);
    waited.abort();
    if (!turnCame) {
      throw operationErrors.create("operation.deadline_exceeded");
    }
    return await work();
  } finally {
    finish(true);
    if (turns.get(key) === mine) {
      turns.delete(key);
    }
  }
};
