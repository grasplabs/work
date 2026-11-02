/**
 * One client's deploy to its target release, as a run on Workerflow
 * (src/workflow-runs.ts): the only thing the reconciler starts
 * (src/rollout/reconciler.ts). It runs the client's one operation for the
 * release (src/hosting/operation.ts): resources and migrations, each
 * Worker in turn, the probe and the router's map. On the release the
 * client runs already, it runs it again with the shared secrets in
 * Secrets Store now (a secrets rollout, src/rollout/secrets.ts).
 *
 * The reconciler claimed the client for this run before creating it (in
 * `client_runs` and `client_deploys`, one batch), so nothing else changes
 * what the client runs while it goes. Each attempt of the deploy step
 * takes the client for itself (`takeAttempt`): one that timed out acts no
 * more beside its retry. Taken to another release, a probe that fails
 * once live rolls it back on its own (`release_rolled_back`).
 *
 * However it ends, its last step records the result on `client_deploys`
 * and gives the claim back, audited. A run that never gets there
 * (terminated) is settled by the reconciler's next tick.
 */
import type { WorkflowDefinition } from "@grasp-os/workerflow/contracts";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { actIfChanged, adminDatabase } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import { clientDeploys } from "../db/schema.ts";
import { deployContext } from "../deploy/context.ts";
import type { DeployContext } from "../deploy/context.ts";
import { errorCode } from "../deploy/errors.ts";
import { InventoryError } from "../hosting/inventory.ts";
import {
  ProvisionOperationError,
  provisionOf,
  recordUnstarted,
  runClientProvision,
  startClientRelease,
} from "../hosting/operation.ts";
import { releaseRun, takeAttempt } from "../runners.ts";
import {
  deployStepConfig,
  guarded,
  quickStep,
  stop,
  stopReason,
} from "../workflow-steps.ts";
import { runningRelease, targetClient } from "./targets.ts";

/** What a deploy's run is started with: identifiers only, as its journal keeps them. */
const deployParamsSchema = z.object({
  clientId: z.string(),
  releaseId: z.string(),
});
export type DeployParams = z.infer<typeof deployParamsSchema>;

/** The code at the front of a stop's reason (`<code>: <words>`). */
export const codeOf = (reason: string): string =>
  reason.split(":", 1)[0] ?? reason;

/**
 * Records run `runId`'s deploy of client `clientId` ended, `error` null
 * when it worked, and gives the client back, audited once: only while the
 * client's deploy is still this run's.
 */
export const recordEnd = async (
  db: AdminDatabase,
  {
    clientId,
    runId,
    releaseId,
  }: { clientId: string; runId: string; releaseId: string },
  error: string | null
): Promise<void> => {
  await actIfChanged(
    db,
    "system",
    db
      .update(clientDeploys)
      .set({
        status: error === null ? "done" : "failed",
        error,
        endedAt: new Date(),
      })
      .where(
        and(
          eq(clientDeploys.clientId, clientId),
          eq(clientDeploys.runId, runId),
          eq(clientDeploys.status, "deploying")
        )
      ),
    error === null
      ? {
          action: "deploy.done",
          clientId,
          target: releaseId,
          detail: { run: runId },
        }
      : {
          action: "deploy.fail",
          clientId,
          target: releaseId,
          detail: { run: runId, error },
        },
    [releaseRun(db, clientId, runId)]
  );
};

/**
 * Starts the client's operation on `releaseId` as run `runId`, which holds
 * it, and returns the release it ran before: what a failed probe rolls
 * back to. Already started (a retry of the step), it goes on.
 */
const start = async (
  db: AdminDatabase,
  { clientId, releaseId }: DeployParams,
  runId: string
): Promise<string | null> => {
  const client = await targetClient(db, clientId);
  if (client === undefined) {
    throw stop("not_active", `${clientId} is gone`);
  }
  const running = runningRelease(client);
  await startClientRelease(
    db,
    "system",
    { clientId, runId },
    {
      releaseId,
      again: running === releaseId,
      what: client.rotationPending ? "settings_and_secrets" : "secrets",
    }
  );
  return running;
};

/**
 * Runs the client's operation as this attempt of run `runId` alone, and
 * stops (`release_rolled_back`) when a failed probe took it back off the
 * release.
 */
const run = async (
  env: Env,
  { clientId, releaseId }: DeployParams,
  runId: string,
  {
    from,
    attempt,
    attemptKey,
  }: { from: string | null; attempt: number; attemptKey: string }
): Promise<void> => {
  const db = adminDatabase(env.DB);
  const held = { clientId, runId, attempt, attemptKey };
  // An earlier try finished the operation, but its result was lost
  // before the engine kept it: done already.
  const before = await provisionOf(db, clientId);
  if (before?.status !== "done" || before.runId !== runId) {
    if (!(await takeAttempt(db, held))) {
      throw stop(
        "runner_replaced",
        `${runId} no longer holds ${clientId} for attempt ${attempt}`
      );
    }
    let context: DeployContext;
    try {
      context = await deployContext(env);
    } catch (error) {
      await recordUnstarted(db, held, errorCode(error));
      throw error;
    }
    try {
      await runClientProvision(context, held, {
        rollBackOnProbe: from !== releaseId,
      });
    } catch (error) {
      if (
        error instanceof ProvisionOperationError ||
        error instanceof InventoryError
      ) {
        throw stop(error.code, error.message);
      }
      throw error;
    }
  }
  const after = await provisionOf(db, clientId);
  if (after?.releaseId !== releaseId) {
    throw stop(
      "release_rolled_back",
      `${clientId} failed its probe on ${releaseId} and was rolled back`
    );
  }
};

/** A client's deploy, as a run: started, run, then its result recorded. */
export const deployRun = (env: Env): WorkflowDefinition => ({
  run: async (event, step): Promise<void> => {
    const params = deployParamsSchema.parse(event.payload);
    const runId = event.instanceId;
    const db = adminDatabase(env.DB);
    const ending = { ...params, runId };
    try {
      const from = await step.do(
        "start",
        quickStep,
        guarded(async () => await start(db, params, runId))
      );
      await step.do(
        "deploy",
        deployStepConfig,
        guarded(async ({ attempt, idempotencyKey }) => {
          await run(env, params, runId, {
            from,
            attempt,
            attemptKey: idempotencyKey,
          });
        })
      );
    } catch (error) {
      await step.do("record failure", quickStep, async () => {
        await recordEnd(db, ending, codeOf(stopReason(error)));
      });
      throw error;
    }
    await step.do("record done", quickStep, async () => {
      await recordEnd(db, ending, null);
    });
  },
});
