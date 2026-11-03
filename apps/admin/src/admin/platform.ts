/**
 * Every company on the Platform page as a model: what needs a look and
 * how each stands, the ones that need a look first. Pure: it works from
 * the client grid's rows and what the grid read live of each account.
 * Where each stands against its channel is the channels' own
 * (src/rollout/progress.ts).
 */
import type { GridRow, LiveStatus } from "../clients/grid.ts";
import type { AttentionReason } from "../hosting/attention.ts";
import type { NotStarted } from "../hosting/placement.ts";

/** What about a company needs someone at Grasp, the most pressing first. */
export type PlatformNeed =
  | { kind: "needs_attention"; reason: AttentionReason }
  | { kind: "not_started"; why: NotStarted | null }
  | { kind: "stopped" }
  | { kind: "setup_unread" }
  | { kind: "failed"; releaseId: string }
  | { kind: "drift"; drift: "drifted" | "split" | "off_pin" };

export const needsOf = (row: GridRow, live?: LiveStatus): PlatformNeed[] => {
  if (row.status === "offboarded") {
    return [];
  }
  const needs: PlatformNeed[] = [];
  // Being set up: what waits for staff there, in place of a deploy's.
  if (row.setup?.state === "needs_attention") {
    needs.push({ kind: "needs_attention", reason: row.setup.reason });
  } else if (row.setup?.state === "not_started") {
    needs.push({ kind: "not_started", why: row.setup.why });
  } else if (row.setup?.state === "stopped") {
    needs.push({ kind: "stopped" });
  } else if (row.setup?.state === "unread") {
    needs.push({ kind: "setup_unread" });
  } else if (row.lastDeploy?.status === "failed") {
    needs.push({ kind: "failed", releaseId: row.lastDeploy.releaseId });
  }
  const drift = live?.drift;
  if (drift === "drifted" || drift === "split" || drift === "off_pin") {
    needs.push({ kind: "drift", drift });
  }
  return needs;
};

/**
 * How a company stands, as one word. `unread`: active, nothing recorded
 * needs a look, but it wasn't read (yet, or the read failed or timed
 * out), so whether it drifted isn't known; never called healthy unread.
 */
export type Standing =
  | "attention"
  | "setup"
  | "unread"
  | "healthy"
  | "offboarded";

/**
 * Whether it was read for what a standing needs: its drift. A read that
 * failed or timed out comes back with it unknown (`gridLive`), which says
 * nothing about it.
 */
const wasRead = (live: LiveStatus | undefined): boolean =>
  live !== undefined && live.drift !== "unknown";

export const standingOf = (
  row: GridRow,
  live: LiveStatus | undefined
): Standing => {
  if (row.status === "offboarded") {
    return "offboarded";
  }
  if (needsOf(row, live).length > 0) {
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
  live: Readonly<Record<string, LiveStatus>>
): { row: GridRow; standing: Standing; needs: PlatformNeed[] }[] =>
  rows
    .map((row) => ({
      row,
      standing: standingOf(row, live[row.id]),
      needs: needsOf(row, live[row.id]),
    }))
    .toSorted(
      (a, b) =>
        standingOrder[a.standing] - standingOrder[b.standing] ||
        a.row.name.localeCompare(b.row.name)
    );

/**
 * What the admin's sidebar says beside Platform: how many companies need a
 * look by what the admin recorded alone (a failed last deploy, setting up
 * that stopped). No live read: the sidebar shows on every admin page, and
 * drift and errors are the page's to read.
 */
export interface PlatformCounts {
  needLook: number;
}

export const platformCounts = (rows: readonly GridRow[]): PlatformCounts => ({
  needLook: rows.filter((row) => needsOf(row).length > 0).length,
});
