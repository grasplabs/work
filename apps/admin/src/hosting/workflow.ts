/**
 * Provisioning a placed client, as a Cloudflare Workflow: each instance is
 * one attempt, claimed in D1 first (src/runners.ts), and every attempt
 * runs the client's one operation (src/hosting/operation.ts), which
 * resumes from what earlier attempts did. Staff start it, or start it
 * again after it stopped, with `provisionPlacedClient`: the same call
 * either way, since a retry resumes the operation rather than start
 * another.
 *
 * Parameters and step results are identifiers only: Workflows stores
 * them (threat model R17).
 */
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import type { Staff } from "../access.ts";
import { adminDatabase } from "../db/act.ts";
import { deployContext } from "../deploy/context.ts";
import { ProvisionError } from "../provision/errors.ts";
import { claimRun, currentRun, hasEnded } from "../runners.ts";
import { asStepError, deployStepConfig, stop } from "../workflow-steps.ts";
import { InventoryError } from "./inventory.ts";
import {
  ProvisionOperationError,
  runClientProvision,
  startClientProvision,
  startClientRelease,
} from "./operation.ts";

/** What an attempt is started with. */
export interface ProvisionPlacedParams {
  clientId: string;
}

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

export class ProvisionPlacedClient extends WorkflowEntrypoint<
  Env,
  ProvisionPlacedParams
> {
  override async run(
    event: WorkflowEvent<ProvisionPlacedParams>,
    step: WorkflowStep
  ): Promise<void> {
    const { clientId } = event.payload;
    await step.do("provision", deployStepConfig, async () => {
      try {
        await runClientProvision(await deployContext(this.env), {
          clientId,
          runId: event.instanceId,
        });
      } catch (error) {
        throw asOperationStepError(error);
      }
    });
  }
}

/** A new attempt's instance id: the client's, and a random part of its own. */
const newAttemptId = (clientId: string): string =>
  `${clientId}-p${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

/**
 * Claims client `clientId` for a new attempt in place of its current
 * runner once that has ended, recording `event`, and starts the attempt,
 * which runs the client's one operation. Refused (`already_running`)
 * while another runner is still going, and when another claim got there
 * first. Returns the attempt's id.
 */
const startAttempt = async (
  env: Env,
  staff: Staff,
  clientId: string,
  record: (replaces: string | null) => Promise<{
    action: string;
    target: string;
    detail: Record<string, string>;
  }>
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
  const event = await record(run?.runId ?? null);
  const runId = await claimRun(
    db,
    staff,
    clientId,
    run?.runId ?? null,
    {
      ...event,
      clientId,
      detail: {
        ...event.detail,
        ...(run === null ? {} : { replaces: run.runId }),
      },
    },
    { kind: "provision_placed", runId: newAttemptId(clientId) }
  );
  if (runId === undefined) {
    throw running;
  }
  await env.PROVISION_PLACED_CLIENT.create({
    id: runId,
    params: { clientId } satisfies ProvisionPlacedParams,
  });
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
  await startAttempt(env, staff, clientId, async () => {
    const operation = await startClientProvision(
      adminDatabase(env.DB),
      staff,
      clientId,
      releaseId
    );
    return {
      action: "client.provision_placed",
      target: releaseId,
      detail: { operation },
    };
  });

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
  await startAttempt(env, staff, clientId, async () => {
    const { operationId, releaseId } = await startClientRelease(
      adminDatabase(env.DB),
      staff,
      clientId,
      to
    );
    return {
      action:
        "rollback" in to ? "client.rollback_placed" : "client.release_placed",
      target: releaseId,
      detail: { operation: operationId },
    };
  });
