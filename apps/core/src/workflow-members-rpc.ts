import type {
  ShareCandidates,
  SubjectMember,
  SubjectMembersApi,
} from "@grasp-os/shared/subject-members";

import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { requireNotStaff, shareCandidates } from "./sharing.ts";
import {
  requireWorkflowRole,
  shareWorkflowResource,
  unshareWorkflowResource,
  workflowMembers,
} from "./workflow-resources.ts";

/** A signed-in person's `workflowResources.members`. */
export class WorkflowMembersRpc
  extends CoreRpcTarget
  implements SubjectMembersApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(id: string): Promise<SubjectMember[]> {
    return await withPerson(
      this.#check,
      async (person) => await workflowMembers(this.#env, person, id)
    );
  }

  async add(id: string, member: unknown): Promise<SubjectMember> {
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

  /** For whoever may share it: a builder, never Grasp staff. */
  async candidates(id: string): Promise<ShareCandidates> {
    return await withPerson(this.#check, async (person) => {
      requireNotStaff(person);
      await requireWorkflowRole(this.#env, person, id, "builder");
      return await shareCandidates(this.#env, person);
    });
  }
}
