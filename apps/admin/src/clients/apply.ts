/**
 * Applying a client's settings now, without waiting for a rollout: its
 * operation run again for the release it runs (src/hosting/operation.ts),
 * so its core gets its sign-in and settings, and a rotation of its
 * secrets that waits goes live. Staff start it from the client's page.
 *
 * It's a runner like the others (src/runners.ts): it claims the client
 * with the same conditional write, audited (`client.apply_settings`), so
 * it never runs beside a rollout, a rollback or provisioning, and its
 * Workflow (`ApplyClient`) runs the operation as that runner and releases
 * the client when it's done, whether it worked or not.
 */
import { log } from "@grasp-os/shared/log";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import type { Staff } from "../access.ts";
import { adminDatabase } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import { deployContext } from "../deploy/context.ts";
import { errorCode } from "../deploy/errors.ts";
import { InventoryError } from "../hosting/inventory.ts";
import {
  ProvisionOperationError,
  runClientProvision,
  startClientRelease,
} from "../hosting/operation.ts";
import { runningRelease, targetClient } from "../rollout/targets.ts";
import { claimRun, currentRun, hasEnded, releaseRun } from "../runners.ts";
import {
  deployStepConfig,
  guarded,
  isEngineAbort,
  quickStep,
  stop,
  stopReason,
} from "../workflow-steps.ts";
import { SettingsError } from "./settings.ts";

/** What an apply's run is started with: identifiers only. */
export interface ApplyParams {
  clientId: string;
  /** The staff member who asked for it. */
  startedBy: Staff;
}

/** A new apply run's instance id. */
const newApplyId = (): string =>
  `apply-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

/** Releases client `clientId` from runner `runId`, logging a failure to. */
const releaseQuietly = async (
  db: AdminDatabase,
  clientId: string,
  runId: string
): Promise<void> => {
  try {
    await releaseRun(db, clientId, runId);
  } catch (error) {
    log.error("apply.release_failed", { clientId, error: errorCode(error) });
  }
};

/**
 * Starts applying client `clientId`'s settings, as `staff`, and returns
 * its run's id. Refused for a client the admin doesn't have
 * (`unknown_client`), one that isn't active (`not_active`), one whose
 * Workers don't run one release (`nothing_deployed`), and while another
 * runner has it (`client_busy`).
 *
 * The release checked here only decides whether to start: the run reads
 * the release it deploys again once it holds the client, so a rollout
 * that lands before the claim is the release it deploys.
 */
export const applySettings = async (
  env: Env,
  staff: Staff,
  clientId: string
): Promise<string> => {
  const db = adminDatabase(env.DB);
  const client = await targetClient(db, clientId);
  if (client === undefined) {
    throw new SettingsError("unknown_client", `No client ${clientId}`);
  }
  if (client.status !== "active") {
    throw new SettingsError("not_active", `${clientId} isn't active`);
  }
  if (runningRelease(client) === null) {
    throw new SettingsError(
      "nothing_deployed",
      `${clientId}'s Workers don't run one release`
    );
  }
  const busy = new SettingsError(
    "client_busy",
    `${clientId} has another runner`
  );
  const run = await currentRun(env, clientId);
  if (run !== null && !hasEnded(run.status)) {
    throw busy;
  }
  const runId = await claimRun(
    db,
    staff,
    clientId,
    run?.runId ?? null,
    { action: "client.apply_settings", clientId },
    { kind: "apply", runId: newApplyId() }
  );
  if (runId === undefined) {
    throw busy;
  }
  const params: ApplyParams = {
    clientId,
    startedBy: { email: staff.email, sub: staff.sub },
  };
  try {
    await env.APPLY_CLIENT.create({ id: runId, params });
  } catch (error) {
    // Its run never started: the client is free again, the error stands.
    await releaseQuietly(db, clientId, runId);
    throw error;
  }
  return runId;
};

/**
 * Applies a client's settings: runs its operation again for the release it
 * runs, as the client's runner (`startClientRelease`, `again`), then
 * releases the client, whether it worked or not. The release is read in
 * the run, which holds the client: no other runner changes it after.
 */
export class ApplyClient extends WorkflowEntrypoint<Env, ApplyParams> {
  override async run(
    event: WorkflowEvent<ApplyParams>,
    step: WorkflowStep
  ): Promise<void> {
    const { clientId, startedBy } = event.payload;
    const db = adminDatabase(this.env.DB);
    try {
      await step.do(
        "start",
        quickStep,
        guarded(async () => {
          const client = await targetClient(db, clientId);
          const releaseId =
            client === undefined ? null : runningRelease(client);
          if (client === undefined || releaseId === null) {
            throw stop(
              "nothing_deployed",
              `${clientId}'s Workers don't run one release`
            );
          }
          // As the client's runner, which claimed it before this run began.
          await startClientRelease(
            db,
            startedBy,
            { clientId, runId: event.instanceId },
            {
              releaseId,
              again: true,
              // New secrets go with it when a rotation waits too.
              what: client.rotationPending
                ? "settings_and_secrets"
                : "settings",
            }
          );
        })
      );
      await step.do(
        "deploy",
        deployStepConfig,
        guarded(async () => {
          // As the client's runner: it stops if another takes the client.
          try {
            // The release it runs, again: going back a release wouldn't
            // undo a setting that broke it.
            await runClientProvision(
              await deployContext(this.env),
              { clientId, runId: event.instanceId },
              { rollBackOnProbe: false }
            );
          } catch (error) {
            if (
              error instanceof ProvisionOperationError ||
              error instanceof InventoryError
            ) {
              throw stop(error.code, error.message);
            }
            throw error;
          }
        })
      );
    } catch (error) {
      if (isEngineAbort(error)) {
        throw error;
      }
      await step.do("release after failing", quickStep, async () => {
        log.warn("apply.stopped", { clientId, error: stopReason(error) });
        await releaseQuietly(db, clientId, event.instanceId);
      });
      throw error;
    }
    await step.do("release", quickStep, async () => {
      await releaseRun(db, clientId, event.instanceId);
    });
  }
}
