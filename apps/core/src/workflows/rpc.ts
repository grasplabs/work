import type {
  ConnectionWorkflows,
  RunActivity,
  RunActivityQuery,
  RunsPage,
  RunFilter,
  WorkflowsApi,
  WorkflowSummary,
  WorkflowsToday,
} from "@grasp-os/shared/workflows";

import { CoreRpcTarget } from "../rpc-target.ts";
import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import { runActivity } from "./activity.ts";
import { connectionWorkflows } from "./connection-workflows.ts";
import { listAllRuns, workflowOverview } from "./overview.ts";
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

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
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

  async teams(): Promise<{ id: string; name: string }[]> {
    return await withPerson(
      this.#check,
      async (by) => await teamChoices(this.#env, by)
    );
  }
}
