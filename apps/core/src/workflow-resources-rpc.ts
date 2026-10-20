import type { WorkflowRunTrace } from "@grasp-os/shared/workflow-diagrams";
import type {
  AppWorkflowBinding,
  CatalogContractEntry,
  WorkflowBindingApproval,
  WorkflowDraft,
  WorkflowMember,
  WorkflowParams,
  WorkflowResource,
  WorkflowResourcesApi,
  WorkflowResourceRun,
  WorkflowResourceVersion,
  WorkflowStart,
  WorkflowVersionSource,
} from "@grasp-os/shared/workflow-resources";

import {
  bindWorkflowToApp,
  unbindWorkflowFromApp,
} from "./app-workflow-bindings.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import {
  approveWorkflowBinding,
  listWorkflowBindings,
  revokeWorkflowBinding,
} from "./workflow-bindings.ts";
import {
  catalogContracts,
  publishCatalogContract,
} from "./workflow-catalog.ts";
import {
  editWorkflowDraft,
  publishWorkflowDraft,
  workflowDraft,
} from "./workflow-drafts.ts";
import { setWorkflowParams, workflowParams } from "./workflow-params.ts";
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
  workflowSource,
  workflowVersions,
} from "./workflow-resources.ts";
import { startWorkflow } from "./workflow-starts.ts";
import { resourceRunTrace } from "./workflows/resource-run-trace.ts";
import {
  listResourceRuns,
  resourceRunFor,
  terminateResourceRun,
} from "./workflows/resource-runs.ts";
import { sealPackages } from "./workflows/sealed-packages.ts";

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
        await publishWorkflowVersion(this.#env, person, id, input, sealPackages)
    );
  }

  async draft(id: string): Promise<WorkflowDraft> {
    return await withPerson(
      this.#check,
      async (person) => await workflowDraft(this.#env, person, id)
    );
  }

  async editDraft(id: string, input: unknown): Promise<WorkflowDraft> {
    return await withPerson(
      this.#check,
      async (person) => await editWorkflowDraft(this.#env, person, id, input)
    );
  }

  async publishDraft(
    id: string,
    input: unknown
  ): Promise<WorkflowResourceVersion> {
    return await withPerson(
      this.#check,
      async (person) => await publishWorkflowDraft(this.#env, person, id, input)
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

  async source(id: string, version: number): Promise<WorkflowVersionSource> {
    return await withPerson(
      this.#check,
      async (person) => await workflowSource(this.#env, person, id, version)
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

  async run(id: string, runId: string): Promise<WorkflowResourceRun> {
    return await withPerson(
      this.#check,
      async (person) => await resourceRunFor(this.#env, person, id, runId)
    );
  }

  async runs(id: string): Promise<WorkflowResourceRun[]> {
    return await withPerson(
      this.#check,
      async (person) => await listResourceRuns(this.#env, person, id)
    );
  }

  async runTrace(id: string, runId: string): Promise<WorkflowRunTrace> {
    return await withPerson(
      this.#check,
      async (person) => await resourceRunTrace(this.#env, person, id, runId)
    );
  }

  async terminateRun(id: string, runId: string): Promise<WorkflowResourceRun> {
    return await withPerson(
      this.#check,
      async (person) => await terminateResourceRun(this.#env, person, id, runId)
    );
  }

  async delete(id: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await deleteWorkflowResource(this.#env, person, id);
    });
  }

  async params(id: string): Promise<WorkflowParams> {
    return await withPerson(
      this.#check,
      async (person) => await workflowParams(this.#env, person, id)
    );
  }

  async setParams(id: string, input: unknown): Promise<WorkflowParams> {
    return await withPerson(
      this.#check,
      async (person) => await setWorkflowParams(this.#env, person, id, input)
    );
  }

  async bindings(id: string): Promise<WorkflowBindingApproval[]> {
    return await withPerson(
      this.#check,
      async (person) => await listWorkflowBindings(this.#env, person, id)
    );
  }

  async approveBinding(
    id: string,
    input: unknown
  ): Promise<WorkflowBindingApproval> {
    return await withPerson(
      this.#check,
      async (person) =>
        await approveWorkflowBinding(this.#env, person, id, input)
    );
  }

  async revokeBinding(id: string, approval: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await revokeWorkflowBinding(this.#env, person, id, approval);
    });
  }

  async bindToApp(id: string, input: unknown): Promise<AppWorkflowBinding> {
    return await withPerson(
      this.#check,
      async (person) => await bindWorkflowToApp(this.#env, person, id, input)
    );
  }

  async unbindFromApp(binding: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await unbindWorkflowFromApp(this.#env, person, binding);
    });
  }

  async catalog(): Promise<CatalogContractEntry[]> {
    return await withPerson(
      this.#check,
      async (person) => await catalogContracts(this.#env, person)
    );
  }

  async publishContract(input: unknown): Promise<CatalogContractEntry> {
    return await withPerson(
      this.#check,
      async (person) => await publishCatalogContract(this.#env, person, input)
    );
  }
}
