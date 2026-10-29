/**
 * Provisioning a placed client, as a workflow (src/workflow-runs.ts): each
 * run is one attempt, claimed in D1 first (src/runners.ts), and every attempt
 * runs the client's one operation (src/hosting/operation.ts), which
 * resumes from what earlier attempts did. Staff start it, or start it
 * again after it stopped, with `provisionPlacedClient`: the same call
 * either way, since a retry resumes the operation rather than start
 * another.
 *
 * Parameters and step results are identifiers only: the run's journal
 * keeps them (threat model R17).
 */
import type { WorkflowDefinition } from "@grasp-os/workerflow/contracts";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { sendStaffAlert } from "../alerts.ts";
import { adminDatabase } from "../db/act.ts";
import { deployContext } from "../deploy/context.ts";
import { ProvisionError } from "../provision/errors.ts";
import {
  claimRun,
  currentRun,
  hasEnded,
  releaseRun,
  takeAttempt,
} from "../runners.ts";
import type { HeldClient } from "../runners.ts";
import { adminWorkflow, adminWorkflows } from "../workflow-runs.ts";
import { asStepError, stop, workerflowDeployStep } from "../workflow-steps.ts";
import { InventoryError } from "./inventory.ts";
import {
  ProvisionOperationError,
  provisionOf,
  runClientProvision,
  startClientProvision,
  startClientRelease,
} from "./operation.ts";

/** What an attempt is started with. */
const provisionPlacedParamsSchema = z.object({ clientId: z.string() });
export type ProvisionPlacedParams = z.infer<typeof provisionPlacedParamsSchema>;

/** The attempts' runs. */
export const provisionAttempts = (
  env: Pick<Env, "ADMIN_RUNS" | "DURABLE_OBJECT_JURISDICTION">
) =>
  adminWorkflow<ProvisionPlacedParams>(
    env,
    adminWorkflows.provisionPlacedClient
  );

/**
 * A step's failure: the operation's and the inventory's own codes stop
 * the attempt at once, for staff to act on; anything else as any step's
 * (`asStepError`), so a smoke check still starting or an API that didn't
 * answer is retried, resuming the operation.
 */
const asOperationStepError = (error: unknown): Error =>
  error instanceof ProvisionOperationError || error instanceof InventoryError
    ? stop(error.code, error.message)
    : asStepError(error);

/**
 * An attempt: the client's operation, run as one step. Each try of the
 * step takes the client for itself first (`takeAttempt`): one that timed
 * out goes on beside its retry, and from then on every check and write
 * of it is refused. A try that finds the operation done by this run
 * already succeeds at once: an earlier try finished it, and released the
 * client, but its result was lost before the engine kept it.
 */
export const provisionPlacedClientRun = (env: Env): WorkflowDefinition => ({
  run: async (event, step): Promise<void> => {
    const { clientId } = provisionPlacedParamsSchema.parse(event.payload);
    await step.do("provision", workerflowDeployStep, async ({ attempt }) => {
      const held = { clientId, runId: event.instanceId, attempt };
      try {
        const context = await deployContext(env);
        const operation = await provisionOf(context.db, clientId);
        if (operation?.status === "done" && operation.runId === held.runId) {
          return;
        }
        if (!(await takeAttempt(context.db, held))) {
          throw new ProvisionOperationError(
            "runner_replaced",
            `${held.runId} no longer holds ${clientId} for attempt ${attempt}`
          );
        }
        await runClientProvision(
          {
            ...context,
            alert: async (alert) => {
              await sendStaffAlert(env, alert);
            },
          },
          held
        );
      } catch (error) {
        throw asOperationStepError(error);
      }
    });
  },
});

/** A new attempt's instance id: the client's, and a random part of its own. */
const newAttemptId = (clientId: string): string =>
  `${clientId}-p${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

/**
 * Claims client `clientId` for a new attempt in place of its current
 * runner once that has ended, recording `event`, then, holding it, starts
 * the operation (`start`, every write of which is conditional on the
 * claim) and the attempt that runs it. The claim comes first: a start
 * that doesn't win it changes nothing, so it never rewrites the operation
 * another attempt runs. A start refused once claimed gives the claim
 * back. Refused (`already_running`) while another runner is still going,
 * and when another claim got there first. Returns the attempt's id.
 */
const startAttempt = async (
  env: Env,
  staff: Staff,
  clientId: string,
  event: { action: string; target: string },
  start: (held: HeldClient) => Promise<void>
): Promise<string> => {
  const db = adminDatabase(env.DB);
  const running = new ProvisionError(
    "already_running",
    `Client ${clientId} is being worked on already`
  );
  const run = await currentRun(env, clientId);
  if (run !== null && !hasEnded(run.status)) {
    throw running;
  }
  const runId = await claimRun(
    db,
    staff,
    clientId,
    run?.runId ?? null,
    {
      ...event,
      clientId,
      ...(run === null ? {} : { detail: { replaces: run.runId } }),
    },
    { kind: "provision_placed", runId: newAttemptId(clientId) }
  );
  if (runId === undefined) {
    throw running;
  }
  try {
    await start({ clientId, runId });
    await provisionAttempts(env).create({ id: runId, params: { clientId } });
  } catch (error) {
    // Nothing runs for it: the client is free for the next start.
    await releaseRun(db, clientId, runId);
    throw error;
  }
  return runId;
};

/**
 * Starts provisioning placed client `clientId` with release `releaseId`,
 * as `staff`, or resumes its operation: records the operation (or finds
 * it: one of another release is refused, `operation_release_changed`),
 * claims the client for a new attempt in place of its current runner once
 * that has ended, and starts the attempt. Refused (`already_running`)
 * while another runner is still going, and when another claim got there
 * first. Returns the attempt's id.
 */
export const provisionPlacedClient = async (
  env: Env,
  staff: Staff,
  clientId: string,
  releaseId: string
): Promise<string> =>
  await startAttempt(
    env,
    staff,
    clientId,
    { action: "client.provision_placed", target: releaseId },
    async (held) => {
      await startClientProvision(adminDatabase(env.DB), staff, held, releaseId);
    }
  );

/**
 * Takes active placed client `clientId` to release `releaseId`, or with
 * `rollback` back to the release it ran before, as `staff`
 * (`startClientRelease`), and starts an attempt that runs its operation
 * for it, as provisioning does. Starting it again after it stopped
 * resumes it. Returns the attempt's id.
 */
export const releasePlacedClient = async (
  env: Env,
  staff: Staff,
  clientId: string,
  to: { releaseId: string } | { rollback: true }
): Promise<string> =>
  await startAttempt(
    env,
    staff,
    clientId,
    "rollback" in to
      ? { action: "client.rollback_placed", target: "previous" }
      : { action: "client.release_placed", target: to.releaseId },
    async (held) => {
      await startClientRelease(adminDatabase(env.DB), staff, held, to);
    }
  );
