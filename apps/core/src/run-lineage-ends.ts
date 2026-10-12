import { inArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { workflowRuns } from "./db/core/schema.ts";

// When a run lineage has ended, for the model ledger to prune what it
// keeps of one (model-ledger.ts). The ledger asks core's own records of
// the runs, `workflow_runs`, which only core writes: a run's root
// (`root_run_id`, written once when core starts it) and whether it has
// ended (`status`, which only core sets, and never back from an ended
// one). Nothing an App, a screen or a run's code passes says a lineage
// has ended, so nothing can be told to end one early: the ledger calls no
// one, and no one calls the ledger to say so.

/** Most lineages one question names: two lists of them, within D1's 100 bound values. */
export const lineagesAsked = 40;

/** The run statuses that haven't ended (workflows/runs.ts, `unended`). */
const live = ["starting", "running", "paused"] as const;

/**
 * Which of the lineages `roots` (root run IDs) have ended: every run of
 * each, the root and all it started at any depth, has ended, the last no
 * later than `endedBy` (ms since the epoch). A lineage core has no run of
 * is never taken for ended: core keeps every run's row, so it was never a
 * run core started, and nothing says when it ended. Nor is a run another
 * started: its rows count under its own root, never under its ID.
 */
export const endedLineages = async (
  env: Pick<Env, "DB">,
  roots: readonly string[],
  endedBy: number
): Promise<Set<string>> => {
  if (roots.length === 0) {
    return new Set();
  }
  if (roots.length > lineagesAsked) {
    throw new Error(`Ask about at most ${lineagesAsked} lineages at a time`);
  }
  const db = drizzle(env.DB);
  const lineage = sql<string>`coalesce(${workflowRuns.rootRunId}, ${workflowRuns.id})`;
  const rows = await db
    .select({
      lineage,
      live: sql<number>`sum(case when ${inArray(workflowRuns.status, [...live])} then 1 else 0 end)`,
      lastEnded: sql<number | null>`max(${workflowRuns.endedAt})`,
    })
    .from(workflowRuns)
    .where(
      or(
        inArray(workflowRuns.id, [...roots]),
        inArray(workflowRuns.rootRunId, [...roots])
      )
    )
    .groupBy(lineage);
  const known = new Map(rows.map((row) => [row.lineage, row]));
  return new Set(
    roots.filter((root) => {
      const found = known.get(root);
      return (
        found !== undefined &&
        found.live === 0 &&
        found.lastEnded !== null &&
        found.lastEnded <= endedBy
      );
    })
  );
};
