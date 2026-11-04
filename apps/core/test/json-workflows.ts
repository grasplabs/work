import { env } from "cloudflare:workers";

import { runObjectOf } from "../src/workflows/engine.ts";

// What a run's journal recorded of its steps, as the engine keeps it.

/** How many times run `runId`'s journal completed each step, by name. */
export const completedSteps = async (
  runId: string
): Promise<Map<string, number>> => {
  const page = await runObjectOf(env, runId).history({ after: 0, limit: 500 });
  const completed = new Map<string, number>();
  for (const record of page?.records ?? []) {
    const step = record.unreadable ? null : record.step;
    if (
      step !== null &&
      !record.unreadable &&
      record.type === "step_completed"
    ) {
      completed.set(step.name, (completed.get(step.name) ?? 0) + 1);
    }
  }
  return completed;
};
