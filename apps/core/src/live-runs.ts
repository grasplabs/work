import { and, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { workflowResourceRuns, workflowRuns } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";

// Which workflow runs are still live, for whatever keeps something for as
// long as a run lives: the receipts of record saves (knowledge/
// receipts.ts) and of business store mutations (data-store.ts), which an
// App's run and an independent workflow's run (workflows/resource-runs.ts,
// through a store operation) both leave.

/** The runs of `runIds` that are live: started and not yet ended. */
export const liveRuns = async (
  env: Env,
  runIds: readonly string[]
): Promise<Set<string>> => {
  if (runIds.length === 0) {
    return new Set();
  }
  const db = drizzle(env.DB);
  const [apps, independent] = await Promise.all([
    db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(
        and(
          inList(workflowRuns.id, runIds),
          inArray(workflowRuns.status, ["starting", "running", "paused"])
        )
      ),
    db
      .select({ id: workflowResourceRuns.id })
      .from(workflowResourceRuns)
      .where(
        and(
          inList(workflowResourceRuns.id, runIds),
          inArray(workflowResourceRuns.status, ["starting", "running"])
        )
      ),
  ]);
  return new Set([...apps, ...independent].map(({ id }) => id));
};
