import { functionErrors } from "@grasp-os/shared/functions";
import {
  inTurn as inTurnOf,
  turnsUnderWay,
} from "@grasp-os/shared/shared-runs";
import type { Turns } from "@grasp-os/shared/shared-runs";

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

/** Each run's calls, taking their turns one at a time, by run. */
const turnsOf = new Map<string, Turns>();

/**
 * The most calls one run may have queued at once, the one taking its turn
 * among them: past it, a call is refused as busy, to try again, so a run
 * making calls by the thousand holds no more than this many in core.
 */
export const maxQueuedPerRun = 8;

/**
 * Runs `work` once the calls run `key` made before it have finished, one
 * at a time (no key: at once), or refuses with
 * `function.deadline_exceeded` if its turn doesn't come by `until`, and
 * with `function.sandbox_busy` if the run has {@link maxQueuedPerRun}
 * calls queued already. A call that gives up waiting still holds its place
 * behind one that runs on (past its deadline, say, while its sandbox lets
 * go), so the next call made waits for that one, never running beside it;
 * a call whose request was cancelled, and so never ends, holds it no
 * longer than its own time (shared-runs.ts).
 */
export const inTurn = async <T>(
  key: string | undefined,
  until: number,
  work: () => Promise<T>
): Promise<T> => {
  if (key === undefined) {
    return await work();
  }
  // A run's entry goes once nothing of it is under way, also one a
  // cancelled call left behind, found so by any later call.
  for (const [run, turns] of turnsOf) {
    if (turnsUnderWay(turns) === 0) {
      turnsOf.delete(run);
    }
  }
  const turns = turnsOf.get(key) ?? {};
  turnsOf.set(key, turns);
  if (turnsUnderWay(turns) >= maxQueuedPerRun) {
    throw functionErrors.create("function.sandbox_busy");
  }
  return await inTurnOf(turns, Math.max(until - Date.now(), 0), work, {
    at: until,
    error: () => functionErrors.create("function.deadline_exceeded"),
  });
};
