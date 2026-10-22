import { appIdSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  workflowResourceRuns,
  workflowStartReceipts,
} from "../db/core/schema.ts";
import { appHost } from "../durable-objects.ts";

// Run status, live, on an App's screens: each time one of its runs
// starts, waits for a decision, has it answered or closed, or ends, core
// tells the App's host (app.ts, `runChanged`), which tells the screens
// following that workflow (`ScreenFrameApi.watchRuns`), each push checked by
// screens-rpc.ts as every push to a screen is. A push says only which run
// changed: the screen reads it again, as its person, with what they may
// see of it. Reading again, rather than taking a status from the push,
// also means pushes that overtake each other can't leave a screen showing
// an older status than the one it read last.

/**
 * Tells the screens of the run's App that `run` changed. Best effort, after
 * the change is written: it never fails what changed the run, and a push
 * that doesn't arrive is made up for by the next one, or by the screen
 * reading its runs again when it follows again.
 */
export const tellScreens = async (
  env: Env,
  run: { id: string; appId: string; workflowId: string }
): Promise<void> => {
  try {
    await appHost(env, appIdSchema.parse(run.appId)).runChanged(
      run.workflowId,
      run.id
    );
  } catch (error) {
    log.warn("workflow.screens_not_told", {
      runId: run.id,
      ...errorFields(error),
    });
  }
};

/**
 * Tells the live queries of the App that started independent run `id`, if
 * an App did, that its person's runs of the App's workflow references
 * changed: admitted, a new status, ended. Each connection of that person
 * that follows a workflow query of the App (`workflows.<alias>.queries.*`,
 * workflow-reference-queries.ts) reads it again, through the gate, the
 * coalescing and the live-read budget a write to a table it read goes
 * through (query-subscriptions.ts). The signal names no run and carries
 * nothing: what a read answers is what the person may see now. Best
 * effort, after the change is written: it never fails what changed the
 * run, and a screen not told keeps what it shows until it follows again.
 */
export const tellQueryFollowers = async (
  env: Env,
  id: string
): Promise<void> => {
  try {
    const run = await drizzle(env.DB)
      .select({
        invokerType: workflowStartReceipts.invokerType,
        invokerId: workflowStartReceipts.invokerId,
        principal: workflowResourceRuns.principalId,
      })
      .from(workflowResourceRuns)
      .innerJoin(
        workflowStartReceipts,
        eq(workflowStartReceipts.id, workflowResourceRuns.id)
      )
      .where(eq(workflowResourceRuns.id, id))
      .get();
    // Only an App's runs are what its workflow queries answer.
    if (run?.invokerType !== "app") {
      return;
    }
    await appHost(env, appIdSchema.parse(run.invokerId)).workflowRunsChanged(
      run.principal
    );
  } catch (error) {
    log.warn("workflow.query_followers_not_told", {
      runId: id,
      ...errorFields(error),
    });
  }
};
