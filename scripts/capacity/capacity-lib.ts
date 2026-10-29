/**
 * The capacity job for a release (run-capacity.ts, GRA-942): which of its
 * platform limits it raises over the release published before it, and the
 * workload (workloads.ts) that has to pass at each raised value, on one
 * runtime profile, on the release's own commit.
 *
 * What a passing job proves, and what it must not:
 * - It proves that on commit C, the release's own (`manifest.commit`, and
 *   the commit the job checked out, `GITHUB_SHA`), each raised limit's
 *   workload passed at the value the release raises it to, on the profile
 *   named, in this repository's own CI job on a push to main (the only
 *   event publish runs on; a pull request, and so a fork's, never reaches
 *   it, and has no secrets to read the releases bucket with).
 * - A run on another commit proves nothing: the job refuses one whose
 *   checkout isn't the release's commit, and the evidence names the commit
 *   it ran on, which the admin's import checks is the release's.
 * - A run of another profile proves nothing for this one: each run names
 *   its profile, and the admin needs the client's.
 * - A limit with no workload, or one whose workload doesn't run on the
 *   profile, gets no result at all: nothing to make evidence of, so
 *   publish fails rather than pass a raise unproven.
 * - A workload that ran nothing proves nothing: it passes only when its
 *   run reports at least one test passed, and none failed, was skipped or
 *   left to do (`workloadPassed`), so a mistyped path, a file the config
 *   doesn't include, or one whose tests all skip, never becomes evidence.
 */
import { limitRaises } from "@grasp-os/shared/release";
import type {
  LimitRaise,
  ReleaseManifest,
  RuntimeProfile,
} from "@grasp-os/shared/release";
import { z } from "zod";

import { previousReleaseOf } from "../release/evidence-lib.ts";
import type { CapacityWorkload } from "./workloads.ts";

/** One raise's workload that passed, as the evidence names it. */
export interface CapacityResult {
  limit: string;
  raisedTo: number | null;
  profile: RuntimeProfile;
  commit: string;
}

/** The limits `manifest` raises over the release before it (`previous`). */
export const raisesOf = (
  manifest: ReleaseManifest,
  previous: unknown
): LimitRaise[] => {
  const limits = manifest.platformLimits;
  if (limits === undefined) {
    throw new Error(`Release ${manifest.releaseId} records no platform limits`);
  }
  return limitRaises(
    previousReleaseOf(previous)?.platformLimits ?? limits,
    limits
  );
};

/**
 * The workload to run for each of `raises` on `profile`, in order. Throws
 * for a raise with none there: it can't be proven, so it isn't run.
 */
export const workloadsFor = (
  raises: readonly LimitRaise[],
  profile: RuntimeProfile,
  workloads: Readonly<Record<string, CapacityWorkload>>
): { raise: LimitRaise; workload: CapacityWorkload }[] =>
  raises.map((raise) => {
    const workload = Object.hasOwn(workloads, raise.limit)
      ? workloads[raise.limit]
      : undefined;
    if (workload === undefined || !workload.profiles.includes(profile)) {
      throw new Error(
        `No capacity workload for ${raise.limit} on ${profile}: the pull request that raises it adds one (scripts/capacity/workloads.ts)`
      );
    }
    return { raise, workload };
  });

/**
 * Throws unless the job checked out the release's own commit: a run on
 * any other proves nothing for it.
 */
export const assertOwnCommit = (
  manifest: ReleaseManifest,
  checkedOut: string | undefined
): string => {
  if (checkedOut !== manifest.commit) {
    throw new Error(
      `The capacity job runs on ${checkedOut ?? "an unknown commit"}, not release ${manifest.releaseId}'s ${manifest.commit}`
    );
  }
  return checkedOut;
};

/**
 * Runs each raise's workload in turn with `run` (true when it passed), and
 * answers a result for each, or throws at the first that failed: a release
 * with one unproven raise has no evidence for any.
 */
export const runCapacity = async (
  manifest: ReleaseManifest,
  previous: unknown,
  profile: RuntimeProfile,
  checkedOut: string | undefined,
  workloads: Readonly<Record<string, CapacityWorkload>>,
  run: (workload: CapacityWorkload, raise: LimitRaise) => Promise<boolean>
): Promise<CapacityResult[]> => {
  const raises = raisesOf(manifest, previous);
  if (raises.length === 0) {
    return [];
  }
  const commit = assertOwnCommit(manifest, checkedOut);
  const results: CapacityResult[] = [];
  for (const { raise, workload } of workloadsFor(raises, profile, workloads)) {
    // oxlint-disable-next-line no-await-in-loop -- one workload at a time, the runner's whole
    if (!(await run(workload, raise))) {
      throw new Error(
        `The capacity workload for ${raise.limit} failed at ${raise.raisedTo ?? "unbounded"} on ${profile}`
      );
    }
    results.push({ ...raise, profile, commit });
  }
  return results;
};

/** What a workload's run reports, as Vitest's JSON reporter writes it. */
const reportSchema = z.object({
  success: z.boolean(),
  numPassedTests: z.int(),
  numFailedTests: z.int(),
  numPendingTests: z.int(),
  numTodoTests: z.int(),
});

/**
 * Whether a workload's run (`report`, Vitest's JSON reporter's output)
 * proves it held: it succeeded, at least one test passed, and none failed,
 * was skipped or left to do. A report that doesn't parse proves nothing.
 */
export const workloadPassed = (report: unknown): boolean => {
  const parsed = reportSchema.safeParse(report);
  if (!parsed.success) {
    return false;
  }
  const run = parsed.data;
  return (
    run.success &&
    run.numPassedTests > 0 &&
    run.numFailedTests === 0 &&
    run.numPendingTests === 0 &&
    run.numTodoTests === 0
  );
};
