import { readdirSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Where each test run keeps what its global setup builds: a directory of
 * its own, named by the run's process. Two runs in one checkout (agents
 * sharing a worktree) then never remove or rewrite what the other's
 * Workers are reading. Vitest loads core's config and runs the global
 * setup in that one process, so both name the same directory.
 */
const testRuns = path.join(import.meta.dirname, "../dist/test-runs");

/** This run's directory. */
export const testRun = path.join(testRuns, String(process.pid));

/**
 * The static assets core's tests serve: a stand-in frontend, so tests don't
 * wait for a build of apps/web, and the App compiler and the extractor,
 * as core's deploy puts them next to the frontend.
 */
export const testAssets = path.join(testRun, "assets");

/** Whether a process runs: signal 0 only checks it can be signalled. */
const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Running, but another user's.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/**
 * Removes what runs left behind that no longer run (killed before their
 * teardown), so the directories don't pile up. A live run's is kept.
 */
export const removeEndedRuns = (): void => {
  let names: string[];
  try {
    names = readdirSync(testRuns);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(name);
    if (Number.isInteger(pid) && pid !== process.pid && !isRunning(pid)) {
      rmSync(path.join(testRuns, name), { recursive: true, force: true });
    }
  }
};

/** Removes this run's directory, once its tests are done. */
export const removeTestRun = (): void => {
  rmSync(testRun, { recursive: true, force: true });
};
