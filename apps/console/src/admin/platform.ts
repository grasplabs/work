/**
 * The admin's Platform page as a model, ported from the prototype
 * (grasplabs/prototype `lib/admin-platform.ts`): the rollout going out
 * ring by ring, which company runs which release, and every company in
 * the order that needs a look first. Pure: it works from what the
 * console recorded (its releases, rollouts and their targets, and the
 * client grid's rows) and what the grid read live of each account.
 *
 * Not the prototype's: rings are the console's own, any number from 0
 * (src/clients/settings.ts), so a rollout's rings are those its targets
 * are in, and the ring after the one it waits after is the next of
 * those, as approving it moves on to (src/rollout/control.ts).
 */
import type { GridRow, LiveStatus } from "../clients/grid.ts";
import type { ReleaseSummary } from "../releases/queries.ts";
import type { RolloutSummary, TargetView } from "../rollout/queries.ts";

/** A last day's error rate at or above this needs a look. */
export const errorRateLimit = 0.01;

/** So many releases behind the newest, unpinned, needs a look. */
export const behindLimit = 2;

/**
 * The rollout the page shows: the one going out (running, or waiting
 * for approval), or else the latest. `rollouts` come latest first.
 */
export const goingOut = (
  rollouts: readonly RolloutSummary[]
): RolloutSummary | null =>
  rollouts.find(({ status }) => status === "running" || status === "waiting") ??
  rollouts[0] ??
  null;

/** Where one ring of a rollout stands. */
export type RingState =
  | "done"
  | "running"
  | "waiting"
  | "failed"
  | "stopped"
  | "todo";

/** One ring of a rollout: its companies, and how many are where. */
export interface RingProgress {
  ring: number;
  targets: TargetView[];
  /** On it, or skipped (on it already, or pinned elsewhere). */
  done: number;
  /** Failed, or rolled back. */
  failed: number;
  /** Stopped part way when the rollout was cancelled. */
  stopped: number;
  moving: number;
  waiting: number;
  state: RingState;
}

/** The ring a waiting rollout goes on to once approved: the next ring of its targets. */
export const nextRing = (
  rollout: Pick<RolloutSummary, "status" | "ring">,
  targets: readonly TargetView[]
): number | null => {
  if (rollout.status !== "waiting") {
    return null;
  }
  const after = targets
    .map(({ ring }) => ring)
    .filter((ring) => ring > rollout.ring);
  return after.length === 0 ? null : Math.min(...after);
};

const ringStateOf = (
  rollout: Pick<RolloutSummary, "status" | "ring">,
  ring: number,
  next: number | null,
  {
    failed,
    stopped,
    moving,
    waiting,
  }: Pick<RingProgress, "failed" | "stopped" | "moving" | "waiting">
): RingState => {
  if (failed > 0) {
    return "failed";
  }
  if (stopped > 0) {
    return "stopped";
  }
  // A rollout that failed before it reached one of the ring's companies
  // (reading its targets, say) leaves them pending: the ring failed too.
  // One that failed with the ring done (waiting to approve the next) leaves
  // the ring done.
  if (
    rollout.status === "failed" &&
    ring === rollout.ring &&
    waiting + moving > 0
  ) {
    return "failed";
  }
  if (
    ring < rollout.ring ||
    (ring === rollout.ring && waiting + moving === 0)
  ) {
    return "done";
  }
  if (ring === rollout.ring) {
    return "running";
  }
  return ring === next ? "waiting" : "todo";
};

/** A rollout ring by ring, lowest first: each ring its targets are in. */
export const ringsOf = (
  rollout: Pick<RolloutSummary, "status" | "ring">,
  targets: readonly TargetView[]
): RingProgress[] => {
  const next = nextRing(rollout, targets);
  const rings = [...new Set(targets.map(({ ring }) => ring))].toSorted(
    (a, b) => a - b
  );
  return rings.map((ring) => {
    const of = targets.filter((target) => target.ring === ring);
    const count = (...statuses: TargetView["status"][]): number =>
      of.filter(({ status }) => statuses.includes(status)).length;
    const progress = {
      failed: count("failed", "rolled_back"),
      stopped: count("stopped"),
      moving: count("deploying"),
      waiting: count("pending"),
    };
    return {
      ring,
      targets: of,
      done: count("done", "skipped"),
      ...progress,
      state: ringStateOf(rollout, ring, next, progress),
    };
  });
};

/** The newest release first. */
const newestFirst = (releases: readonly ReleaseSummary[]): ReleaseSummary[] =>
  releases.toSorted(
    (a, b) =>
      b.builtAt.getTime() - a.builtAt.getTime() || b.id.localeCompare(a.id)
  );

/**
 * Which active companies run each release, the newest release first; then
 * any release a company runs that `releases` doesn't list (older than the
 * releases the page reads), as its id alone.
 */
export const spreadOf = (
  rows: readonly GridRow[],
  releases: readonly ReleaseSummary[]
): {
  releaseId: string;
  release: ReleaseSummary | null;
  clientIds: string[];
}[] => {
  const active = rows.filter(({ status }) => status === "active");
  const on = (releaseId: string): string[] =>
    active.filter((row) => row.release === releaseId).map(({ id }) => id);
  const listed = new Set(releases.map(({ id }) => id));
  const unlisted = [
    ...new Set(
      active.flatMap(({ release }) =>
        release === null || listed.has(release) ? [] : [release]
      )
    ),
  ].toSorted((a, b) => b.localeCompare(a));
  return [
    ...newestFirst(releases).map((release) => ({
      releaseId: release.id,
      release,
      clientIds: on(release.id),
    })),
    ...unlisted.map((releaseId) => ({
      releaseId,
      release: null,
      clientIds: on(releaseId),
    })),
  ];
};

/** Of the last day's requests, the share that ended in an error; null without any, or unread. */
export const errorRateOf = (live: LiveStatus | undefined): number | null => {
  const day = live?.day;
  return day === undefined || day === null || day.requests === 0
    ? null
    : day.errors / day.requests;
};

/**
 * How many releases came after the one the company runs: 0 when it runs
 * none; every listed one when it runs a release older than all of them.
 */
export const behindOf = (
  row: GridRow,
  releases: readonly ReleaseSummary[]
): number => {
  if (row.release === null) {
    return 0;
  }
  const index = newestFirst(releases).findIndex(({ id }) => id === row.release);
  return index === -1 ? releases.length : index;
};

/** What about a company needs someone at Grasp, the most pressing first. */
export type PlatformNeed =
  | { kind: "failed"; releaseId: string }
  | { kind: "drift"; drift: "drifted" | "split" | "off_pin" }
  | { kind: "errors"; rate: number }
  | { kind: "behind"; releases: number };

export const needsOf = (
  row: GridRow,
  live: LiveStatus | undefined,
  releases: readonly ReleaseSummary[]
): PlatformNeed[] => {
  if (row.status === "offboarded") {
    return [];
  }
  const needs: PlatformNeed[] = [];
  if (row.lastDeploy?.status === "failed") {
    needs.push({ kind: "failed", releaseId: row.lastDeploy.releaseId });
  }
  const drift = live?.drift;
  if (drift === "drifted" || drift === "split" || drift === "off_pin") {
    needs.push({ kind: "drift", drift });
  }
  const rate = errorRateOf(live);
  if (rate !== null && rate >= errorRateLimit) {
    needs.push({ kind: "errors", rate });
  }
  // A pinned company stays behind on purpose.
  const behind = row.pinnedReleaseId === null ? behindOf(row, releases) : 0;
  if (behind >= behindLimit) {
    needs.push({ kind: "behind", releases: behind });
  }
  return needs;
};

/** How a company stands, as one word. */
/**
 * How a company stands, as one word. `unread`: active, nothing recorded
 * needs a look, but its account wasn't read (yet, or the read failed or
 * timed out), so whether it drifted or errs isn't known; never called
 * healthy unread.
 */
export type Standing =
  | "attention"
  | "setup"
  | "unread"
  | "healthy"
  | "offboarded";

/**
 * Whether the account was read for what a standing needs: its drift and
 * its last day's requests. A read that failed or timed out comes back with
 * them unknown (`gridLive`), which says nothing about either.
 */
const wasRead = (live: LiveStatus | undefined): boolean =>
  live !== undefined && live.drift !== "unknown" && live.day !== null;

export const standingOf = (
  row: GridRow,
  live: LiveStatus | undefined,
  releases: readonly ReleaseSummary[]
): Standing => {
  if (row.status === "offboarded") {
    return "offboarded";
  }
  if (needsOf(row, live, releases).length > 0) {
    return "attention";
  }
  if (row.status === "provisioning") {
    return "setup";
  }
  return wasRead(live) ? "healthy" : "unread";
};

const standingOrder: Record<Standing, number> = {
  attention: 0,
  setup: 1,
  unread: 2,
  healthy: 3,
  offboarded: 4,
};

/** Every company, the ones that need a look first, then by name. */
export const companiesOf = (
  rows: readonly GridRow[],
  live: Readonly<Record<string, LiveStatus>>,
  releases: readonly ReleaseSummary[]
): { row: GridRow; standing: Standing; needs: PlatformNeed[] }[] =>
  rows
    .map((row) => ({
      row,
      standing: standingOf(row, live[row.id], releases),
      needs: needsOf(row, live[row.id], releases),
    }))
    .toSorted(
      (a, b) =>
        standingOrder[a.standing] - standingOrder[b.standing] ||
        a.row.name.localeCompare(b.row.name)
    );
