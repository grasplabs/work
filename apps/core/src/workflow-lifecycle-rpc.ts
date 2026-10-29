import type {
  WorkflowGoLiveWaiting,
  WorkflowLifecycle,
  WorkflowLifecycleApi,
} from "@grasp-os/shared/workflow-lifecycle";

import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import {
  decideGoLive,
  goLivesWaiting,
  pauseWorkflow,
  requestGoLive,
  resumeWorkflow,
  setWorkflowStage,
  workflowLifecycle,
} from "./workflow-lifecycle.ts";

/**
 * A signed-in person's `workflowResources.lifecycle` (workflow-lifecycle.ts,
 * where who may do what is decided).
 */
export class WorkflowLifecycleRpc
  extends CoreRpcTarget
  implements WorkflowLifecycleApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async get(id: string): Promise<WorkflowLifecycle> {
    return await withPerson(
      this.#check,
      async (person) => await workflowLifecycle(this.#env, person, id)
    );
  }

  async setStage(id: string, input: unknown): Promise<WorkflowLifecycle> {
    return await withPerson(
      this.#check,
      async (person) => await setWorkflowStage(this.#env, person, id, input)
    );
  }

  async pause(id: string, input: unknown): Promise<WorkflowLifecycle> {
    return await withPerson(
      this.#check,
      async (person) => await pauseWorkflow(this.#env, person, id, input)
    );
  }

  async resume(id: string, input: unknown): Promise<WorkflowLifecycle> {
    return await withPerson(
      this.#check,
      async (person) => await resumeWorkflow(this.#env, person, id, input)
    );
  }

  async requestGoLive(id: string, input: unknown): Promise<WorkflowLifecycle> {
    return await withPerson(
      this.#check,
      async (person) => await requestGoLive(this.#env, person, id, input)
    );
  }

  async decideGoLive(id: string, input: unknown): Promise<WorkflowLifecycle> {
    return await withPerson(
      this.#check,
      async (person) => await decideGoLive(this.#env, person, id, input)
    );
  }

  async waiting(): Promise<WorkflowGoLiveWaiting[]> {
    return await withPerson(
      this.#check,
      async (person) => await goLivesWaiting(this.#env, person)
    );
  }
}
