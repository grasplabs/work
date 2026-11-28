/**
 * One client's deploy to its target release, as a run on Workerflow
 * (src/workflow-runs.ts): the only thing the rollout pass starts
 * (src/rollout/scheduler.ts). It runs the client's one operation for the
 * release (src/hosting/operation.ts): resources and migrations, each
 * Worker in turn, the probe and the router's map. On the release the
 * client runs already, it runs it again with the shared secrets in
 * Secrets Store now (src/rollout/shared-secrets.ts).
 *
 * The pass claimed the client for this run before creating it (in
 * `client_runs` and `client_deploys`, one batch), so nothing else changes
 * what the client runs while it goes. Each attempt of the deploy step
 * takes the client for itself (`takeAttempt`): one that timed out acts no
 * more beside its retry. Taken to another release, a probe that fails
 * once live rolls it back on its own (`release_rolled_back`).
 *
 * However it ends, its last step records the result on `client_deploys`
 * and gives the claim back, audited. A run that never gets there
 * (terminated) is settled by the pass's next run.
 */
import "@tanstack/react-start/server-only";
import type { WorkflowDefinition } from "@grasp-os/workerflow/contracts";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { alert } from "../alerts/alert.ts";
import { actIfChanged, adminDatabase } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import { clientDeploys } from "../db/schema.ts";
import { deployContext } from "../deploy/context.ts";
import type { DeployContext } from "../deploy/context.ts";
import { errorCode } from "../deploy/errors.ts";
import { InventoryError } from "../hosting/inventory.ts";
import {
  ProvisionOperationError,
  lostAttemptOf,
  provisionOf,
  recordUnstarted,
  runClientProvision,
  startClientRelease,
} from "../hosting/operation.ts";
import { releaseRun, stillHolds, takeAttempt } from "../runners.ts";
import type { HeldClient } from "../runners.ts";
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
 * What the engine fails a step with when its last attempt ended without
 * an outcome of its own: cut off (its isolate killed) or timed out, as
 * Cloudflare Workflows names them.
 */
const lostAttemptErrors: ReadonlySet<string> = new Set([
  "WorkflowInternalError",
  "WorkflowTimeoutError",
]);

/**
 * The code run `runId`'s deploy of `clientId` failed with: for an
 * attempt the engine cut off, the step the operation was left in
 * (`lostAttemptOf`), not the engine's own words; otherwise the stop's.
 */
export const failureCodeOf = async (
  db: AdminDatabase,
  { clientId, runId }: { clientId: string; runId: string },
  error: unknown
): Promise<string> => {
  const lost =
    error instanceof Error && lostAttemptErrors.has(error.name)
      ? await lostAttemptOf(db, clientId, runId)
      : null;
  return lost ?? codeOf(stopReason(error));
};

/**
 * How a failed deploy ended, beyond its code: put back on the release
 * before (`restored`), or the failure (`cause`) a restore was refused or
 * failed after (src/rollout/org-rollout.ts).
 */
export interface DeployEnd {
  restored?: boolean;
  cause?: string;
  /**
   * The attempt that records it, which must still hold the client: one
   * that timed out records nothing over the attempt after it, nor gives
   * that one's claim back.
   */
  held?: HeldClient;
}

/** The codes of a restore that didn't put the release before back: each tells staff at once. */
const unrestored = ["restore_refused", "restore_failed"] as const;
const isUnrestored = (error: string): error is (typeof unrestored)[number] =>
  unrestored.some((code) => code === error);

/**
 * Records run `runId`'s deploy of client `clientId` ended, `error` null
 * when it worked, and gives the client back, audited once, and alerted:
 * only while the client's deploy is still this run's. A failure restored
 * to the release before tells nobody by itself (the rollout counts it);
 * one whose restore was refused or failed tells staff as urgent.
 */
export const recordEnd = async (
  db: AdminDatabase,
  {
    clientId,
    runId,
    releaseId,
  }: { clientId: string; runId: string; releaseId: string },
  error: string | null,
  { restored = false, cause, held }: DeployEnd = {}
): Promise<void> => {
  const recorded = await actIfChanged(
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
          eq(clientDeploys.status, "deploying"),
          held === undefined ? undefined : stillHolds(held)
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
          detail: {
            run: runId,
            error,
            ...(restored ? { restored } : {}),
            ...(cause === undefined ? {} : { cause }),
          },
        },
    [releaseRun(db, clientId, runId, held?.attempt, held?.attemptKey)]
  );
  // A failed deploy alerts staff once, and the next one that works says
  // it recovered (src/alerts/alert.ts).
  if (!recorded || (error !== null && restored)) {
    return;
  }
  if (error === null) {
    await alert(db, { kind: "deployed", clientId, releaseId });
  } else if (isUnrestored(error)) {
    await alert(db, {
      kind: error,
      clientId,
      releaseId,
      code: codeOf(cause ?? error),
    });
  } else {
    await alert(db, {
      kind: "deploy_failed",
      clientId,
      releaseId,
      code: codeOf(error),
    });
  }
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
        await recordEnd(db, ending, await failureCodeOf(db, ending, error));
      });
      throw error;
    }
    await step.do("record done", quickStep, async () => {
      await recordEnd(db, ending, null);
    });
  },
});
