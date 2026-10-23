/**
 * Deploying one fleet client of a rollout, as a Cloudflare Workflow
 * (src/rollout/workflow.ts starts it, `deployFleet`).
 */
import { log } from "@grasp-os/shared/log";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import { adminDatabase } from "../db/act.ts";
import { errorCode } from "../deploy/deploy.ts";
import type { DeployErrorCode } from "../deploy/errors.ts";
import {
  guarded,
  isEngineAbort,
  quickStep,
  stopReason,
} from "../workflow-steps.ts";
import {
  clientEndedEvent,
  codeOf,
  deployClient,
  failTarget,
  recordStop,
} from "./workflow.ts";
import type { RolloutClientParams } from "./workflow.ts";

/**
 * Tells rollout `rolloutId`'s run that fleet client `clientId`'s child
 * ended (`clientEndedEvent`). A failure is logged, not thrown: the run
 * checks on its children when its wait times out all the same.
 */
const sendClientEnded = async (
  env: Env,
  rolloutId: string,
  clientId: string
): Promise<void> => {
  try {
    const rollout = await env.ROLLOUT.get(rolloutId);
    await rollout.sendEvent({ type: clientEndedEvent, payload: { clientId } });
  } catch (error) {
    log.warn("rollout.client_end_untold", {
      rollout: rolloutId,
      client: clientId,
      error: errorCode(error),
    });
  }
};

/**
 * Deploying one fleet client of a rollout, as a Cloudflare Workflow: an
 * instance per client and round (`clientRunId`), started by the rollout's
 * run (`deployFleet`). It deploys the client as the rollout's run deploys
 * one of its first ring (`deployClient`), claimed in the rollout's name,
 * and records how it ended on the client's target: done, skipped, or
 * stopped by the cancellation rule; or failed with its code, audited and
 * released (`failTarget`), which ends this client alone. Neither the
 * engine stopping it nor a rollback that took the client is a failure of
 * the client's: a rollback stops the rollout, recorded as the rollout's
 * run records it (`recordStop`), and the child fails with it. However it
 * ends, short of the engine stopping it, it tells the rollout's run.
 */
export class RolloutClient extends WorkflowEntrypoint<
  Env,
  RolloutClientParams
> {
  override async run(
    event: WorkflowEvent<RolloutClientParams>,
    step: WorkflowStep
  ): Promise<void> {
    const { payload: params } = event;
    const { rolloutId, clientId } = params;
    const db = adminDatabase(this.env.DB);
    const tellRollout = async (): Promise<void> => {
      await step.do("tell rollout", quickStep, async () => {
        await sendClientEnded(this.env, rolloutId, clientId);
      });
    };
    try {
      await deployClient(this.env, step, params, clientId);
    } catch (error) {
      const reason = stopReason(error);
      const replaced: DeployErrorCode = "runner_replaced";
      if (isEngineAbort(error)) {
        throw error;
      }
      if (codeOf(reason) === replaced) {
        await step.do("record stop", quickStep, async () => {
          await recordStop(db, rolloutId, clientId, reason);
        });
        await tellRollout();
        throw error;
      }
      await step.do(
        `${clientId} failed`,
        quickStep,
        guarded(async () => {
          await failTarget(db, rolloutId, clientId, reason);
        })
      );
    }
    await tellRollout();
  }
}
