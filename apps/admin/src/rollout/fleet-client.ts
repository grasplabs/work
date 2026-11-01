/**
 * Deploying one fleet client of a rollout, as a run on Workerflow
 * (src/rollout/workflow.ts starts it, `deployFleet`).
 */
import { log } from "@grasp-os/shared/log";
import type { WorkflowDefinition } from "@grasp-os/workerflow/contracts";
import { z } from "zod";

import { adminDatabase } from "../db/act.ts";
import { errorCode } from "../deploy/errors.ts";
import type { DeployErrorCode } from "../deploy/errors.ts";
import { adminWorkflow, adminWorkflows } from "../workflow-runs.ts";
import { guarded, quickStep, stopReason } from "../workflow-steps.ts";
import {
  clientEndedEvent,
  codeOf,
  deployClient,
  failTarget,
  recordStop,
  rolloutParamsSchema,
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
    const rollout = await adminWorkflow(env, adminWorkflows.rollout).get(
      rolloutId
    );
    await rollout.sendEvent({ type: clientEndedEvent, payload: { clientId } });
  } catch (error) {
    log.warn("rollout.client_end_untold", {
      rollout: rolloutId,
      client: clientId,
      error: errorCode(error),
    });
  }
};

/** `RolloutClientParams`, as a run reads its payload back. */
const rolloutClientParamsSchema = rolloutParamsSchema.extend({
  clientId: z.string(),
  round: z.int(),
});

/**
 * Deploying one fleet client of a rollout, as a run on Workerflow
 * (src/workflow-runs.ts): one per client and round (`clientRunId`), started by the rollout's
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
export const rolloutClientRun = (env: Env): WorkflowDefinition => ({
  run: async (event, step): Promise<void> => {
    const params: RolloutClientParams = rolloutClientParamsSchema.parse(
      event.payload
    );
    const { rolloutId, clientId } = params;
    const db = adminDatabase(env.DB);
    const tellRollout = async (): Promise<void> => {
      await step.do("tell rollout", quickStep, async () => {
        await sendClientEnded(env, rolloutId, clientId);
      });
    };
    try {
      await deployClient(env, step, params, clientId);
    } catch (error) {
      const reason = stopReason(error);
      const replaced: DeployErrorCode = "runner_replaced";
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
  },
});
