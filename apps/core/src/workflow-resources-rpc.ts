import type { RunFileListing } from "@grasp-os/shared/run-files";
import type {
  WorkflowCandidateTrace,
  WorkflowRunTrace,
} from "@grasp-os/shared/workflow-diagrams";
import type {
  AppWorkflowBinding,
  CatalogContractEntry,
  ListedWorkflowBindingApproval,
  PendingWorkflowBindings,
  WorkflowActivity,
  WorkflowBindingApproval,
  WorkflowCandidateRun,
  WorkflowDraft,
  WorkflowFile,
  WorkflowItemTest,
  WorkflowParams,
  WorkflowResource,
  WorkflowResourceRun,
  WorkflowResourcesApi,
  WorkflowStart,
  WorkflowStartForm,
  WorkflowState,
  WorkflowVersionSource,
} from "@grasp-os/shared/workflow-resources";

import { listAppWorkflowBindings } from "./app-workflow-bindings.ts";
import { askableFor } from "./channels/askable-workflows.ts";
import { EventSourcesRpc } from "./event-sources-rpc.ts";
import { makeInProject } from "./projects.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import {
  listWorkflowBindings,
  pendingWorkflowBindings,
  workflowPendingBindings,
} from "./workflow-binding-requests.ts";
import {
  approveWorkflowBinding,
  revokeWorkflowBinding,
} from "./workflow-bindings.ts";
import {
  catalogContracts,
  publishCatalogContract,
} from "./workflow-catalog.ts";
import {
  editWorkflowDraft,
  editWorkflowStep,
  workflowDraft,
} from "./workflow-editor.ts";
import { WorkflowMembersRpc } from "./workflow-members.ts";
import { workflowActivity, workflowFiles } from "./workflow-own.ts";
import { setWorkflowParams, workflowParams } from "./workflow-params.ts";
import { pauseWorkflow, resumeWorkflow } from "./workflow-pause.ts";
import {
  createWorkflowResource,
  deleteWorkflowResource,
  getWorkflowResource,
  listWorkflowResources,
  releaseWorkflowName,
  setWorkflowAskable,
  setWorkflowProcess,
  workflowAskable,
  workflowSource,
} from "./workflow-resources.ts";
import { workflowStartForm } from "./workflow-start-form.ts";
import { startWorkflow } from "./workflow-starts.ts";
import { readWorkflowState, resetWorkflowState } from "./workflow-state.ts";
import { WorkflowTriggersRpc } from "./workflow-triggers-rpc.ts";
import {
  candidateRunFor,
  candidateRunTrace,
  startCandidateRun,
  terminateCandidateRun,
} from "./workflows/candidate-runs.ts";
import { itemTestFor, startItemTest } from "./workflows/item-tests.ts";
import { resourceRunTrace } from "./workflows/resource-run-trace.ts";
import {
  listResourceRuns,
  resourceRunFor,
  terminateResourceRun,
} from "./workflows/resource-runs.ts";
import { runFilesFor } from "./workflows/run-file-downloads.ts";

// Independent workflows over `/rpc` (workflow-resources.ts, where who may
// do what is decided).

/** Independent workflows over `/rpc`, for the signed-in person. */
export class WorkflowResourcesRpc
  extends CoreRpcTarget
  implements WorkflowResourcesApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;
  readonly #members: WorkflowMembersRpc;
  readonly #triggers: WorkflowTriggersRpc;
  readonly #sources: EventSourcesRpc;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
    this.#members = new WorkflowMembersRpc(env, check);
    this.#triggers = new WorkflowTriggersRpc(env, check);
    this.#sources = new EventSourcesRpc(env, check);
  }

  get members(): WorkflowMembersRpc {
    return this.#members;
  }

  get triggers(): WorkflowTriggersRpc {
    return this.#triggers;
  }

  get sources(): EventSourcesRpc {
    return this.#sources;
  }

  async create(name: string, project?: string): Promise<WorkflowResource> {
    return await withPerson(
      this.#check,
      async (person) =>
        await makeInProject(
          this.#env,
          person,
          project,
          "workflow",
          async () => await createWorkflowResource(this.#env, person, name),
          ({ id }) => id
        )
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

  async pause(id: string): Promise<WorkflowResource> {
    return await withPerson(
      this.#check,
      async (person) => await pauseWorkflow(this.#env, person, id)
    );
  }

  async resume(id: string): Promise<WorkflowResource> {
    return await withPerson(
      this.#check,
      async (person) => await resumeWorkflow(this.#env, person, id)
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

  async editStep(id: string, input: unknown): Promise<WorkflowDraft> {
    return await withPerson(
      this.#check,
      async (person) => await editWorkflowStep(this.#env, person, id, input)
    );
  }

  async source(id: string, version: number): Promise<WorkflowVersionSource> {
    return await withPerson(
      this.#check,
      async (person) => await workflowSource(this.#env, person, id, version)
    );
  }

  async askable(id: string): Promise<boolean> {
    return await withPerson(
      this.#check,
      async (person) => await workflowAskable(this.#env, person, id)
    );
  }

  async askableWorkflows(): Promise<{ id: string; name: string }[]> {
    return await withPerson(this.#check, async (person) => {
      const listed = await askableFor(this.#env, person);
      return listed.map(({ id, name }) => ({ id, name }));
    });
  }

  async setAskable(id: string, askable: unknown): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await setWorkflowAskable(this.#env, person, id, askable);
    });
  }

  async start(id: string, input: unknown): Promise<WorkflowStart> {
    return await withPerson(
      this.#check,
      async (person) =>
        await startWorkflow(this.#env, { type: "person", person }, id, input)
    );
  }

  async setProcess(id: string, process: unknown): Promise<WorkflowResource> {
    return await withPerson(
      this.#check,
      async (person) => await setWorkflowProcess(this.#env, person, id, process)
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

  async files(id: string): Promise<WorkflowFile[]> {
    return await withPerson(
      this.#check,
      async (person) => await workflowFiles(this.#env, person, id)
    );
  }

  async activity(id: string): Promise<WorkflowActivity[]> {
    return await withPerson(
      this.#check,
      async (person) => await workflowActivity(this.#env, person, id)
    );
  }

  async startCandidateRun(
    id: string,
    input: unknown
  ): Promise<{ runId: string }> {
    return await withPerson(
      this.#check,
      async (person) => await startCandidateRun(this.#env, person, id, input)
    );
  }

  async candidateRun(id: string, runId: string): Promise<WorkflowCandidateRun> {
    return await withPerson(
      this.#check,
      async (person) => await candidateRunFor(this.#env, person, id, runId)
    );
  }

  async terminateCandidateRun(
    id: string,
    runId: string
  ): Promise<WorkflowCandidateRun> {
    return await withPerson(
      this.#check,
      async (person) =>
        await terminateCandidateRun(this.#env, person, id, runId)
    );
  }

  async candidateRunTrace(
    id: string,
    runId: string
  ): Promise<WorkflowCandidateTrace> {
    return await withPerson(
      this.#check,
      async (person) => await candidateRunTrace(this.#env, person, id, runId)
    );
  }

  async startItemTest(id: string, input: unknown): Promise<WorkflowItemTest> {
    return await withPerson(
      this.#check,
      async (person) => await startItemTest(this.#env, person, id, input)
    );
  }

  async itemTest(id: string, testId: string): Promise<WorkflowItemTest> {
    return await withPerson(
      this.#check,
      async (person) => await itemTestFor(this.#env, person, id, testId)
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

  async runFiles(id: string, runId: string): Promise<RunFileListing[] | null> {
    return await withPerson(
      this.#check,
      async (person) => await runFilesFor(this.#env, person, id, runId)
    );
  }

  async startForm(id: string): Promise<WorkflowStartForm> {
    return await withPerson(
      this.#check,
      async (person) => await workflowStartForm(this.#env, person, id)
    );
  }

  async delete(id: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await deleteWorkflowResource(this.#env, person, id);
    });
  }

  async releaseName(name: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await releaseWorkflowName(this.#env, person, name);
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

  async state(id: string): Promise<WorkflowState> {
    return await withPerson(
      this.#check,
      async (person) => await readWorkflowState(this.#env, person, id)
    );
  }

  async resetState(id: string): Promise<WorkflowState> {
    return await withPerson(
      this.#check,
      async (person) => await resetWorkflowState(this.#env, person, id)
    );
  }

  async bindings(id: string): Promise<ListedWorkflowBindingApproval[]> {
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

  async pendingBindings(): Promise<PendingWorkflowBindings[]> {
    return await withPerson(
      this.#check,
      async (person) => await pendingWorkflowBindings(this.#env, person)
    );
  }

  async pendingBindingsOf(id: string): Promise<PendingWorkflowBindings[]> {
    return await withPerson(
      this.#check,
      async (person) => await workflowPendingBindings(this.#env, person, id)
    );
  }

  async appBindings(app: string): Promise<AppWorkflowBinding[]> {
    return await withPerson(
      this.#check,
      async (person) => await listAppWorkflowBindings(this.#env, person, app)
    );
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
