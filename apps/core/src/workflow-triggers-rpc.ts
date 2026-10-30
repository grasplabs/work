import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowTrigger,
  WorkflowTriggersApi,
} from "@grasp-os/shared/workflow-triggers";
import { z } from "zod";

import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import {
  createTriggerResource,
  deleteTriggerResource,
  listWorkflowTriggers,
  setTriggerEnabled,
  updateTriggerVersion,
  workflowTrigger,
} from "./trigger-resources.ts";

/**
 * A signed-in person's `workflowResources.triggers` (trigger-resources.ts,
 * where who may do what is decided: each call checks it there).
 */
export class WorkflowTriggersRpc
  extends CoreRpcTarget
  implements WorkflowTriggersApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(workflowId: string): Promise<WorkflowTrigger[]> {
    return await withPerson(
      this.#check,
      async (person) =>
        await listWorkflowTriggers(this.#env, person, workflowId)
    );
  }

  async create(input: unknown): Promise<WorkflowTrigger> {
    return await withPerson(this.#check, async (person) => {
      const { id } = await createTriggerResource(this.#env, person, input);
      return await workflowTrigger(this.#env, person, id);
    });
  }

  async setVersion(id: string, version: number): Promise<WorkflowTrigger> {
    return await withPerson(this.#check, async (person) => {
      await updateTriggerVersion(this.#env, person, id, version);
      return await workflowTrigger(this.#env, person, id);
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<WorkflowTrigger> {
    return await withPerson(this.#check, async (person) => {
      // Over RPC anything may arrive: only a boolean says which way.
      const wanted = workflowResourceErrors.parse(
        "workflow.resource_invalid",
        z.boolean(),
        enabled
      );
      await setTriggerEnabled(this.#env, person, id, wanted);
      return await workflowTrigger(this.#env, person, id);
    });
  }

  async delete(id: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await deleteTriggerResource(this.#env, person, id);
    });
  }
}
