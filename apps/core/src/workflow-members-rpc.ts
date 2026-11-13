import type {
  WorkflowMember,
  WorkflowMembersApi,
  WorkflowShareCandidates,
} from "@grasp-os/shared/workflow-resources";

import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import {
  shareWorkflowResource,
  unshareWorkflowResource,
  workflowMembers,
} from "./workflow-resources.ts";
import { workflowShareCandidates } from "./workflow-share-candidates.ts";

/** A signed-in person's `workflowResources.members`. */
export class WorkflowMembersRpc
  extends CoreRpcTarget
  implements WorkflowMembersApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(id: string): Promise<WorkflowMember[]> {
    return await withPerson(
      this.#check,
      async (person) => await workflowMembers(this.#env, person, id)
    );
  }

  async add(id: string, member: unknown): Promise<WorkflowMember> {
    return await withPerson(
      this.#check,
      async (person) =>
        await shareWorkflowResource(this.#env, person, id, member)
    );
  }

  async remove(id: string, member: unknown): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await unshareWorkflowResource(this.#env, person, id, member);
    });
  }

  async candidates(id: string): Promise<WorkflowShareCandidates> {
    return await withPerson(
      this.#check,
      async (person) => await workflowShareCandidates(this.#env, person, id)
    );
  }
}
