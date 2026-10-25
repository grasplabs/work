import {
  consolidationBacklog,
  consolidationJob,
  consolidationThreshold,
  scopesBehind,
} from "@grasp-os/brain/lessons";
import type { ConsolidationScope } from "@grasp-os/brain/lessons";
import { errorFields, log } from "@grasp-os/shared/log";

import { brainOf } from "./knowledge/ports.ts";
import { runEngine } from "./workflows/engine.ts";

// When the Brain consolidates a scope's episodes into lesson candidates
// (GRA-301; @grasp-os/brain/lessons): in the background, never in a task.
// A scope's job starts once enough new episodes arrived (`scheduled`,
// right after a delivery recorded one), and the clock starts one for any
// scope left behind with fewer (`reconcileConsolidation`). A job is named
// by its scope and watermark, so starting it twice is one job, and the
// engine runs it as it runs indexing: durable, retried, bounded.

/** How long a scope's few new episodes wait before the clock takes them. */
const catchUpAfterMs = 60 * 60 * 1000;

/** Scopes the clock starts a job for, a minute at most. */
const scopesPerSweep = 20;

/** Starts `scope`'s consolidation job; one started already stays as it is. */
const start = async (env: Env, scope: ConsolidationScope): Promise<void> => {
  const job = await consolidationJob(brainOf(env), scope);
  await runEngine(env).createInternal({
    id: job.id,
    workflow: "consolidation",
    input: job.input,
  });
};

/**
 * Starts `scope`'s consolidation once enough of its episodes are new;
 * never throws: a delivery's success isn't its learning's.
 */
export const scheduleConsolidation = async (
  env: Env,
  scope: ConsolidationScope
): Promise<void> => {
  try {
    const backlog = await consolidationBacklog(
      brainOf(env),
      scope,
      consolidationThreshold
    );
    if (backlog >= consolidationThreshold) {
      await start(env, scope);
    }
  } catch (error) {
    log.warn("brain.consolidation.schedule_failed", {
      scope: scope.scope,
      ...errorFields(error),
    });
  }
};

/**
 * Starts a job for each scope whose new episodes waited long enough, a
 * bounded number a sweep: the clock's catch-up.
 */
export const reconcileConsolidation = async (env: Env): Promise<void> => {
  const behind = await scopesBehind(
    brainOf(env),
    new Date(Date.now() - catchUpAfterMs),
    scopesPerSweep
  );
  for (const scope of behind) {
    // oxlint-disable-next-line no-await-in-loop -- a bounded few, in turn
    await start(env, scope);
  }
};
