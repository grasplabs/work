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
 * Which of the lineages `keys` names have ended: every run of each, the
 * root and all it started at any depth, has ended, the last no later than
 * `endedBy` (ms since the epoch), and its root started no later than
 * `startedBy`. A key is a lineage's root run, or an
 * App's account in a lineage (workflows/quotas.ts, `accountClaimed`),
 * which ends with its lineage: core's own row of that run names its root.
 * A key core has no run of is never taken for ended: core keeps every
 * run's row, so it was never a run core started, and nothing says when it
 * ended.
 */
export const endedLineages = async (
  env: Pick<Env, "DB">,
  keys: readonly string[],
  { endedBy, startedBy }: { endedBy: number; startedBy: number }
): Promise<Set<string>> => {
  if (keys.length === 0) {
    return new Set();
  }
  if (keys.length > lineagesAsked) {
    throw new Error(`Ask about at most ${lineagesAsked} lineages at a time`);
  }
  const db = drizzle(env.DB);
  const lineage = sql<string>`coalesce(${workflowRuns.rootRunId}, ${workflowRuns.id})`;
  // Each key's lineage, from its run's row.
  const named = await db
    .select({ key: workflowRuns.id, lineage })
    .from(workflowRuns)
    .where(inArray(workflowRuns.id, [...keys]));
  const lineageOf = new Map(named.map((row) => [row.key, row.lineage]));
  const roots = [...new Set(lineageOf.values())];
  if (roots.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({
      lineage,
      live: sql<number>`sum(case when ${inArray(workflowRuns.status, [...live])} then 1 else 0 end)`,
      lastEnded: sql<number | null>`max(${workflowRuns.endedAt})`,
      // The root's start: no run of a lineage starts before its root.
      started: sql<number>`min(${workflowRuns.createdAt})`,
    })
    .from(workflowRuns)
    .where(
      or(
        inArray(workflowRuns.id, roots),
        inArray(workflowRuns.rootRunId, roots)
      )
    )
    .groupBy(lineage);
  const known = new Map(rows.map((row) => [row.lineage, row]));
  return new Set(
    keys.filter((key) => {
      const root = lineageOf.get(key);
      const found = root === undefined ? undefined : known.get(root);
      return (
        found !== undefined &&
        found.live === 0 &&
        found.lastEnded !== null &&
        found.lastEnded <= endedBy &&
        found.started <= startedBy
      );
    })
  );
};
