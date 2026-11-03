import type {
  CreatedWorkflowTrigger,
  WorkflowTrigger,
  WorkflowTriggersApi,
} from "@grasp-os/shared/workflow-triggers";

import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import {
  createTriggerResource,
  deleteTriggerResource,
  listWorkflowTriggers,
  revokeWebhookSecret,
  rotateWebhookSecret,
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

  async create(input: unknown): Promise<CreatedWorkflowTrigger> {
    return await withPerson(this.#check, async (person) => {
      const { id, secret } = await createTriggerResource(
        this.#env,
        person,
        input
      );
      const created = await workflowTrigger(this.#env, person, id);
      // A webhook trigger's secret: answered this once, never again.
      return secret === undefined ? created : { ...created, secret };
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
      await setTriggerEnabled(this.#env, person, id, enabled);
      return await workflowTrigger(this.#env, person, id);
    });
  }

  async delete(id: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await deleteTriggerResource(this.#env, person, id);
    });
  }

  async rotateWebhookSecret(id: string): Promise<{ secret: string }> {
    return await withPerson(
      this.#check,
      async (person) => await rotateWebhookSecret(this.#env, person, id)
    );
  }

  async revokeWebhookSecret(id: string): Promise<WorkflowTrigger> {
    return await withPerson(this.#check, async (person) => {
      await revokeWebhookSecret(this.#env, person, id);
      return await workflowTrigger(this.#env, person, id);
    });
  }
}
