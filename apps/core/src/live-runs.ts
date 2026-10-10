import { and, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { workflowRuns } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";

// Which workflow runs are still live, for whatever keeps something for as
// long as a run lives: the receipts of record saves (knowledge/
// receipts.ts) and of business store mutations (data-store.ts).

/** The runs of `runIds` that are live: started and not yet ended. */
export const liveRuns = async (
  env: Env,
  runIds: readonly string[]
): Promise<Set<string>> => {
  if (runIds.length === 0) {
    return new Set();
  }
  const rows = await drizzle(env.DB)
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(
      and(
        inList(workflowRuns.id, runIds),
        inArray(workflowRuns.status, ["starting", "running", "paused"])
      )
    );
  return new Set(rows.map(({ id }) => id));
};
