import type {
  ConnectionWorkflows,
  RunActivity,
  RunActivityQuery,
  RunHistoryPage,
  RunHistoryPageQuery,
  RunsPage,
  RunFilter,
  WorkflowDetail,
  WorkflowDryRun,
  WorkflowRun,
  WorkflowsApi,
  WorkflowSummary,
  WorkflowsToday,
} from "@grasp-os/shared/workflows";

import { CoreRpcTarget } from "../rpc-target.ts";
import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import { runActivity } from "./activity.ts";
import { connectionWorkflows } from "./connection-workflows.ts";
import { cancelRun } from "./controls.ts";
import { runHistory } from "./history.ts";
import {
  dryRunWorkflow,
  listAllRuns,
  setOwner,
  setTeam,
  workflowDetail,
  workflowOverview,
} from "./overview.ts";
import { WorkflowParamsRpc } from "./params-rpc.ts";
import { listRuns, runStatus, startWorkflow } from "./runs.ts";
import { teamChoices } from "./teams.ts";
import { workflowsToday } from "./today.ts";

/**
 * A signed-in person's `workflows`. Like AppsRpc, every call checks the
 * session first and hands the identity that check
 * returned to the run functions, which check the person's role and
 * validate what the client sent.
 */
export class WorkflowsRpc extends CoreRpcTarget implements WorkflowsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;
  readonly #params: WorkflowParamsRpc;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
    this.#params = new WorkflowParamsRpc(env, check);
  }

  get params(): WorkflowParamsRpc {
    return this.#params;
  }

  async start(
    app: string,
    workflow: string,
    input?: unknown
  ): Promise<WorkflowRun> {
    return await withPerson(
      this.#check,
      async (by) => await startWorkflow(this.#env, by, app, workflow, input)
    );
  }

  async status(run: string): Promise<WorkflowRun> {
    return await withPerson(
      this.#check,
      async (by) => await runStatus(this.#env, by, run)
    );
  }

  async history(
    run: string,
    page?: RunHistoryPageQuery
  ): Promise<RunHistoryPage> {
    return await withPerson(
      this.#check,
      async (by) => await runHistory(this.#env, by, run, page)
    );
  }

  async list(app: string): Promise<WorkflowRun[]> {
    return await withPerson(
      this.#check,
      async (by) => await listRuns(this.#env, by, app)
    );
  }

  async cancel(run: string): Promise<WorkflowRun> {
    return await withPerson(
      this.#check,
      async (by) => await cancelRun(this.#env, by, run)
    );
  }

  async overview(): Promise<WorkflowSummary[]> {
    return await withPerson(
      this.#check,
      async (by) => await workflowOverview(this.#env, by)
    );
  }

  async byConnection(): Promise<ConnectionWorkflows[]> {
    return await withPerson(
      this.#check,
      async (by) => await connectionWorkflows(this.#env, by)
    );
  }

  async runs(filter?: RunFilter): Promise<RunsPage> {
    return await withPerson(
      this.#check,
      async (by) => await listAllRuns(this.#env, by, filter)
    );
  }

  async activity(query?: RunActivityQuery): Promise<RunActivity> {
    return await withPerson(
      this.#check,
      async (by) => await runActivity(this.#env, by, query)
    );
  }

  async today(): Promise<WorkflowsToday> {
    return await withPerson(
      this.#check,
      async (by) => await workflowsToday(this.#env, by)
    );
  }

  async get(app: string, workflow: string): Promise<WorkflowDetail> {
    return await withPerson(
      this.#check,
      async (by) => await workflowDetail(this.#env, by, app, workflow)
    );
  }

  async setOwner(
    app: string,
    workflow: string,
    owner: string
  ): Promise<WorkflowSummary> {
    return await withPerson(
      this.#check,
      async (by) => await setOwner(this.#env, by, app, workflow, owner)
    );
  }

  async setTeam(
    app: string,
    workflow: string,
    team: string | null
  ): Promise<WorkflowSummary> {
    return await withPerson(
      this.#check,
      async (by) => await setTeam(this.#env, by, app, workflow, team)
    );
  }

  async teams(): Promise<{ id: string; name: string }[]> {
    return await withPerson(
      this.#check,
      async (by) => await teamChoices(this.#env, by)
    );
  }

  async test(app: string, workflow: string): Promise<WorkflowDryRun> {
    return await withPerson(
      this.#check,
      async (by) => await dryRunWorkflow(this.#env, by, app, workflow)
    );
  }
}
