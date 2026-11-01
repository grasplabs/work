/**
 * The object each of the admin's workflow runs lives in (src/workflow-runs.ts):
 * Workerflow's run, with the admin's definitions. A run names the
 * definition it was started under; an unknown name runs nothing, and
 * the engine fails the run.
 */
import type {
  DefinitionIdentity,
  WorkflowDefinition,
} from "@grasp-os/workerflow/contracts";
import { WorkflowRun } from "@grasp-os/workerflow/run";

import { applyClient } from "./clients/apply.ts";
import { provisionPlacedClientRun } from "./hosting/workflow.ts";
import { rolloutClientRun } from "./rollout/fleet-client.ts";
import { rollbackClientRun } from "./rollout/rollback.ts";
import { rolloutRun } from "./rollout/workflow.ts";
import { adminWorkflows } from "./workflow-runs.ts";
import type { AdminWorkflow } from "./workflow-runs.ts";

/** Each of the admin's definitions, made with the Worker's env. */
const definitions: Readonly<
  Record<AdminWorkflow, (env: Env) => WorkflowDefinition>
> = {
  [adminWorkflows.applyClient]: applyClient,
  [adminWorkflows.provisionPlacedClient]: provisionPlacedClientRun,
  [adminWorkflows.rollout]: rolloutRun,
  [adminWorkflows.rolloutClient]: rolloutClientRun,
  [adminWorkflows.rollbackClient]: rollbackClientRun,
};

const isAdminWorkflow = (name: string): name is AdminWorkflow =>
  Object.hasOwn(definitions, name);

export class AdminRuns extends WorkflowRun<Env> {
  // The engine's hook: the definition run `definition` runs, made here
  // each activation.
  protected definition({
    definition,
  }: DefinitionIdentity): WorkflowDefinition | undefined {
    return isAdminWorkflow(definition)
      ? definitions[definition](this.env)
      : undefined;
  }
}
