import { inArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { workflowResourceRuns, workflowRuns } from "./db/core/schema.ts";

// When a run lineage has ended, for the model ledger to prune what it
// keeps of one (model-ledger.ts). The ledger asks core's own records of
// the runs, `workflow_runs` for an App's and `workflow_resource_runs` for
// an independent workflow's, which only core writes: a run's root
// (`root_run_id`, written once when core starts it) and whether it has
// ended (`status`, which only core sets, and never back from an ended
// one). Nothing an App, a screen or a run's code passes says a lineage
// has ended, so nothing can be told to end one early: the ledger calls no
// one, and no one calls the ledger to say so.

/** Most lineages one question names: two lists of them, within D1's 100 bound values. */
export const lineagesAsked = 40;

/** The run statuses that haven't ended (workflows/runs.ts, `unended`). */
const live = ["starting", "running", "paused"] as const;

/** A table of core's runs: an App's (`workflow_runs`) or an independent workflow's. */
type RunTable = typeof workflowRuns | typeof workflowResourceRuns;

/** Which of `keys` name an ended lineage of the runs of `runs` (`endedLineages`). */
const endedIn = async (
  db: DrizzleD1Database,
  runs: RunTable,
  keys: readonly string[],
  { endedBy, startedBy }: { endedBy: number; startedBy: number }
): Promise<string[]> => {
  const lineage = sql<string>`coalesce(${runs.rootRunId}, ${runs.id})`;
  // Each key's lineage, from its run's row.
  const named = await db
    .select({ key: runs.id, lineage })
    .from(runs)
    .where(inArray(runs.id, [...keys]));
  const lineageOf = new Map(named.map((row) => [row.key, row.lineage]));
  const roots = [...new Set(lineageOf.values())];
  if (roots.length === 0) {
    return [];
  }
  const rows = await db
    .select({
      lineage,
      live: sql<number>`sum(case when ${inArray(runs.status, [...live])} then 1 else 0 end)`,
      lastEnded: sql<number | null>`max(${runs.endedAt})`,
      // The root's start: no run of a lineage starts before its root.
      started: sql<number>`min(${runs.createdAt})`,
    })
    .from(runs)
    .where(or(inArray(runs.id, roots), inArray(runs.rootRunId, roots)))
    .groupBy(lineage);
  const known = new Map(rows.map((row) => [row.lineage, row]));
  return keys.filter((key) => {
    const root = lineageOf.get(key);
    const found = root === undefined ? undefined : known.get(root);
    return (
      found !== undefined &&
      found.live === 0 &&
      found.lastEnded !== null &&
      found.lastEnded <= endedBy &&
      found.started <= startedBy
    );
  });
};

/**
 * Which of the lineages `keys` names have ended: every run of each, the
 * root and all it started at any depth, has ended, the last no later than
 * `endedBy` (ms since the epoch), and its root started no later than
 * `startedBy`. A key is a lineage's root run, an App's or an independent
 * workflow's, or an App's account in a lineage (workflows/quotas.ts,
 * `accountClaimed`), which ends with its lineage: core's own row of that
 * run names its root. An independent workflow's lineage holds only its
 * own runs (workflows/run-children.ts). A key core has no run of is never
 * taken for ended: core keeps every run's row, so it was never a run core
 * started, and nothing says when it ended.
 */
export const endedLineages = async (
  env: Pick<Env, "DB">,
  keys: readonly string[],
  ends: { endedBy: number; startedBy: number }
): Promise<Set<string>> => {
  if (keys.length === 0) {
    return new Set();
  }
  if (keys.length > lineagesAsked) {
    throw new Error(`Ask about at most ${lineagesAsked} lineages at a time`);
  }
  const db = drizzle(env.DB);
  const [apps, independent] = await Promise.all([
    endedIn(db, workflowRuns, keys, ends),
    endedIn(db, workflowResourceRuns, keys, ends),
  ]);
  return new Set([...apps, ...independent]);
};
