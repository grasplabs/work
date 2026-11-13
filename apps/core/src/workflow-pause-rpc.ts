import type {
  WorkflowPause,
  WorkflowPauseApi,
} from "@grasp-os/shared/workflow-pause";

import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import {
  pauseWorkflow,
  resumeWorkflow,
  workflowPause,
} from "./workflow-pause.ts";

/**
 * A signed-in person's `workflowResources.pause` (workflow-pause.ts,
 * where who may do what is decided).
 */
export class WorkflowPauseRpc
  extends CoreRpcTarget
  implements WorkflowPauseApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async get(id: string): Promise<WorkflowPause> {
    return await withPerson(
      this.#check,
      async (person) => await workflowPause(this.#env, person, id)
    );
  }

  async pause(id: string): Promise<WorkflowPause> {
    return await withPerson(
      this.#check,
      async (person) => await pauseWorkflow(this.#env, person, id)
    );
  }

  async resume(id: string): Promise<WorkflowPause> {
    return await withPerson(
      this.#check,
      async (person) => await resumeWorkflow(this.#env, person, id)
    );
  }
}
