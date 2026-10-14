import type {
  WorkflowMember,
  WorkflowResource,
  WorkflowResourcesApi,
  WorkflowResourceVersion,
  WorkflowStart,
} from "@grasp-os/shared/workflow-resources";

import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import {
  createWorkflowResource,
  deleteWorkflowResource,
  getWorkflowResource,
  listWorkflowResources,
  publishWorkflowVersion,
  shareWorkflowResource,
  unshareWorkflowResource,
  workflowDefinition,
  workflowMembers,
  workflowVersions,
} from "./workflow-resources.ts";
import { startWorkflow } from "./workflow-starts.ts";

// Independent workflows over `/rpc` (workflow-resources.ts, where who may
// do what is decided).

/** Independent workflows over `/rpc`, for the signed-in person. */
export class WorkflowResourcesRpc
  extends CoreRpcTarget
  implements WorkflowResourcesApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async create(name: string): Promise<WorkflowResource> {
    return await withPerson(
      this.#check,
      async (person) => await createWorkflowResource(this.#env, person, name)
    );
  }

  async list(): Promise<WorkflowResource[]> {
    return await withPerson(
      this.#check,
      async (person) => await listWorkflowResources(this.#env, person)
    );
  }

  async get(id: string): Promise<WorkflowResource> {
    return await withPerson(
      this.#check,
      async (person) => await getWorkflowResource(this.#env, person, id)
    );
  }

  async publish(id: string, input: unknown): Promise<WorkflowResourceVersion> {
    return await withPerson(
      this.#check,
      async (person) =>
        await publishWorkflowVersion(this.#env, person, id, input)
    );
  }

  async versions(id: string): Promise<WorkflowResourceVersion[]> {
    return await withPerson(
      this.#check,
      async (person) => await workflowVersions(this.#env, person, id)
    );
  }

  async definition(id: string, version: number): Promise<string> {
    return await withPerson(
      this.#check,
      async (person) => await workflowDefinition(this.#env, person, id, version)
    );
  }

  async share(id: string, input: unknown): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await shareWorkflowResource(this.#env, person, id, input);
    });
  }

  async unshare(id: string, input: unknown): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await unshareWorkflowResource(this.#env, person, id, input);
    });
  }

  async members(id: string): Promise<WorkflowMember[]> {
    return await withPerson(
      this.#check,
      async (person) => await workflowMembers(this.#env, person, id)
    );
  }

  async start(id: string, input: unknown): Promise<WorkflowStart> {
    return await withPerson(
      this.#check,
      async (person) =>
        await startWorkflow(this.#env, { type: "person", person }, id, input)
    );
  }

  async delete(id: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await deleteWorkflowResource(this.#env, person, id);
    });
  }
}
