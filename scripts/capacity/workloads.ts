/**
 * The capacity workload for each platform limit a release may raise
 * (GRA-942), by profile: a test that runs the platform at the limit's
 * raised value and passes only if it holds there. run-capacity.ts runs the
 * workload of each limit a release raises, on the release's own commit,
 * and only a passing run becomes evidence (scripts/release/evidence-lib.ts).
 *
 * A limit with no workload here can't be raised: the capacity job refuses
 * it, so the release has no evidence and publish fails. The pull request
 * that raises a limit adds its workload, reviewed with it.
 *
 * A workload is a test file of core's, run in workerd with the on-premises
 * profile (`vite.on-prem.config.ts`); it reads the value it runs at from
 * `CAPACITY_RAISED_TO` (a number, or `unbounded`).
 */
import type { RuntimeProfile } from "@grasp-os/shared/release";

export interface CapacityWorkload {
  /** Core's test file that runs it, from apps/core. */
  test: string;
  /** The profiles it runs on. */
  profiles: readonly RuntimeProfile[];
}

/** Each limit's workload, by the limit's name in `platformLimits`. */
export const capacityWorkloads: Readonly<Record<string, CapacityWorkload>> = {};

/**
 * What a change has to be reviewed for when a release raises a limit
 * (scripts/release/review-lib.ts): the limits themselves, what proves
 * them (the workloads and their tests, this job, the evidence's making)
 * and the workflow that runs it. A path, or a folder ending in `/`.
 */
export const capacityWatched: readonly string[] = [
  "packages/shared/src/platform-limits.ts",
  "packages/shared/src/release.ts",
  "scripts/capacity/",
  "scripts/release/",
  ".github/",
  ...Object.values(capacityWorkloads).map(({ test }) => `apps/core/${test}`),
];
