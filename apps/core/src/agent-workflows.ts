import { appErrors } from "@grasp-os/shared/apps";
import { isExpectedCode } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Permission } from "@grasp-os/shared/permissions";
import { roleErrors } from "@grasp-os/shared/roles";
import type {
  WorkflowRole,
  WorkflowRunStatus,
} from "@grasp-os/shared/workflow-resources";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type {
  AppWorkflowSummary,
  WorkflowRun,
} from "@grasp-os/shared/workflows";
import { WorkerEntrypoint, exports } from "cloudflare:workers";

import { asPerson } from "./agent-person.ts";
import type { AgentApi, AgentScope } from "./agent-scope.ts";
import { askableFor, offerStart } from "./channels/workflow-offers.ts";
import type { AskableWorkflow } from "./channels/workflow-offers.ts";
import { appHost } from "./durable-objects.ts";
import { listWorkflowResources } from "./workflow-resources.ts";
import { appWorkflowOverview, listAllRuns } from "./workflows/overview.ts";
import { listResourceRuns } from "./workflows/resource-runs.ts";
import { runStatus } from "./workflows/runs.ts";

// Workflows for a chat's code: `await env.workflows.runs("app-1",
// "report")`. What the chat's person sees of them themselves
// (agent-person.ts), of the Apps whose functions the agent may read
// (`readsWorkflow`). The agent sees runs' state here, never what a run
// returned or its error's words: those hold what the run read through its
// App's connections and collections, which the chat has no permission
// for, and whose restricted mode it doesn't share; of a restricted App's
// run not even where it failed, beyond a platform error code. Every call
// is audited as the organization's agent acting for the chat's person.
// Only a chat its person started to fix a failed run gets that run's
// report, attached with the App's sources and restricted mode
// (run-fixes.ts).
//
// In a chat app's chat, the agent may also offer to start a workflow whose
// owner lets people ask for it (`askable`, `offer`): it lists those the
// person could start themselves and puts one, with its values, on a card;
// only the person's press starts it, as them (channels/workflow-offers.ts).
// The owner's choice to open it to asking is what lets the agent see it:
// no permission of the agent's reaches further, and nothing it offers runs
// without the press.

/**
 * Whether the agent may read the runs of App `app`'s workflows: those of
 * an App whose functions it may read (`read` on the App). A permission's
 * workflow object is an independent workflow resource
 * (workflow-resources.ts), never a workflow inside an App, so an App's
 * workflows are read as part of the App.
 */
const readsWorkflow =
  (app: unknown, _workflow?: unknown) =>
  (permissions: Permission[]): boolean =>
    permissions.some(
      ({ object, actions }) =>
        object.type === "app" &&
        object.appId === app &&
        actions.includes("read")
    );

/**
 * Whether the agent may follow the runs of independent workflow
 * `workflow`: `read` on it, a permission of its own an admin grants
 * (workflow-resources.ts), as a person follows it with a role in it.
 */
const followsWorkflow =
  (workflow: unknown) =>
  (permissions: Permission[]): boolean =>
    permissions.some(
      ({ object, actions }) =>
        object.type === "workflow" &&
        object.workflowId === workflow &&
        actions.includes("read")
    );

/** An independent workflow, as the chat's agent lists it. */
export interface AgentIndependentWorkflow {
  id: string;
  name: string;
  /** The version published last; null before the first. */
  currentVersion: number | null;
  /** The person's role in it. */
  role: WorkflowRole;
}

/**
 * A run of an independent workflow, as the chat's agent sees it: its
 * state, never what it returned or why it failed, as for an App's run.
 */
export interface AgentResourceRun {
  id: string;
  workflowId: string;
  version: number;
  status: WorkflowRunStatus;
  /** The person it acts for. */
  principal: string;
  createdAt: string;
  endedAt: string | null;
}

/** A run, as the chat's agent sees it: its state, not what it read. */
export interface AgentRun {
  id: string;
  app: string;
  workflow: string;
  version: number;
  status: WorkflowRun["status"];
  startedBy: WorkflowRun["startedBy"];
  createdAt: string;
  endedAt: string | null;
  /** Where it failed: the step (null outside one) and the error's code. */
  failure: { step: string | null; code: string } | null;
}

/**
 * Where a run failed, as the chat may see it. A step's name is the
 * workflow's to choose (from what it read, even) and an error's code may
 * be its own, so of a restricted App's run, whose data the chat doesn't
 * share, it sees only a code of the platform's.
 */
const failureOf = (
  { failure }: WorkflowRun,
  restricted: boolean
): AgentRun["failure"] => {
  if (failure === undefined) {
    return null;
  }
  const { step, error } = failure;
  if (!restricted) {
    return { step, code: error.code };
  }
  return {
    step: null,
    code: isExpectedCode(error.code) ? error.code : "workflow.run_failed",
  };
};

const agentRun = (run: WorkflowRun, restricted: boolean): AgentRun => ({
  id: run.id,
  app: run.app,
  workflow: run.workflow,
  version: run.version,
  status: run.status,
  startedBy: run.startedBy,
  createdAt: run.createdAt,
  endedAt: run.endedAt,
  failure: failureOf(run, restricted),
});

/** Whether the App `app` has read restricted data (restricted.ts). */
const appRestricted = async (env: Env, app: string): Promise<boolean> =>
  await appHost(env, appIdSchema.parse(app)).isRestricted();

const notFound = () => workflowErrors.create("workflow.run_not_found");

/**
 * A run the agent may not see, as one that doesn't exist: its App is one
 * the person can't open, however it refuses them (none for them, or one
 * shared with them that read what they can't read), or its workflow one
 * the agent may not read. The same refusal as an unknown run, so run IDs
 * can't be probed.
 */
const hidden = (error: unknown): unknown => {
  const code = appErrors.codeOf(error);
  return code === "app.not_found" ||
    code === "app.unreadable" ||
    roleErrors.codeOf(error) !== undefined
    ? notFound()
    : error;
};

/** Workflows, as a chat's code reads them. */
export class WorkflowsApi extends WorkerEntrypoint<Env, AgentScope> {
  /** The workflows the agent may read, of Apps the person sees. */
  async list(): Promise<AppWorkflowSummary[]> {
    return await asPerson(this.env, this.ctx.props, {
      allowed: () => true,
      method: "workflows.list",
      // Only the workflows the agent may read are summed up at all.
      read: async (person, permissions) =>
        await appWorkflowOverview(this.env, person, (app, workflow) =>
          readsWorkflow(app, workflow)(permissions)
        ),
      detail: (listed) => ({ workflows: listed.length }),
    });
  }

  /** A workflow's runs: waiting first, then failed, then newest. */
  async runs(app: unknown, workflow: unknown): Promise<AgentRun[]> {
    return await asPerson(this.env, this.ctx.props, {
      allowed: readsWorkflow(app, workflow),
      method: "workflows.runs",
      read: async (person) => {
        const listed = await listAllRuns(this.env, person, { app, workflow });
        // All of one App's, as the filter names it: its restricted mode,
        // read once.
        const runs = listed.runs.flatMap((run) =>
          run.type === "app" ? [run] : []
        );
        const [first] = runs;
        const restricted =
          first !== undefined && (await appRestricted(this.env, first.app));
        return runs.map((run) => agentRun(run, restricted));
      },
      detail: (listed) => ({
        app: typeof app === "string" ? app : null,
        workflow: typeof workflow === "string" ? workflow : null,
        runs: listed.length,
      }),
    });
  }

  /**
   * The workflows the person could start whose owners let people ask
   * Stephen for them, with the input each takes.
   */
  async askable(): Promise<AskableWorkflow[]> {
    return await asPerson(this.env, this.ctx.props, {
      allowed: () => true,
      method: "workflows.askable",
      read: async (person) => {
        const { via } = this.ctx.props;
        // Offered only on a chat app's card: elsewhere there is none.
        return via === undefined || via === "web"
          ? []
          : await askableFor(this.env, person);
      },
      detail: (listed) => ({ workflows: listed.length }),
    });
  }

  /**
   * The independent workflows the agent may follow, of those the person
   * has a role in. Only their names and versions: following one's runs
   * is `independentRuns`.
   */
  async independent(): Promise<AgentIndependentWorkflow[]> {
    return await asPerson(this.env, this.ctx.props, {
      allowed: () => true,
      method: "workflows.independent",
      read: async (person, permissions) => {
        const listed = await listWorkflowResources(this.env, person);
        return listed.flatMap(({ id, name, currentVersion, role }) =>
          followsWorkflow(id)(permissions)
            ? [{ id, name, currentVersion, role }]
            : []
        );
      },
      detail: (listed) => ({ workflows: listed.length }),
    });
  }

  /**
   * Offers to start workflow `workflow` with `input`, on a card under the
   * answer, which the person presses to start it as them.
   */
  async offer(
    workflow: unknown,
    input: unknown
  ): Promise<{ offer: string; workflow: string; version: number }> {
    return await asPerson(this.env, this.ctx.props, {
      allowed: () => true,
      action: "write",
      method: "workflows.offer",
      read: async (person) =>
        await offerStart(this.env, this.ctx.props, person, workflow, input),
      detail: (offered) => ({
        workflow: offered.workflow,
        version: offered.version,
      }),
    });
  }

  /**
   * An independent workflow's runs, newest first: every run for its
   * builders, a user's own for a user, as the person reads them.
   */
  async independentRuns(workflow: unknown): Promise<AgentResourceRun[]> {
    return await asPerson(this.env, this.ctx.props, {
      allowed: followsWorkflow(workflow),
      method: "workflows.independentRuns",
      read: async (person) => {
        const runs = await listResourceRuns(this.env, person, workflow);
        return runs.map((run) => ({
          id: run.id,
          workflowId: run.workflowId,
          version: run.version,
          status: run.status,
          principal: run.principal,
          createdAt: run.createdAt,
          endedAt: run.endedAt,
        }));
      },
      detail: (listed) => ({
        workflow: typeof workflow === "string" ? workflow : null,
        runs: listed.length,
      }),
    });
  }

  /** One run, as it is now. */
  async status(run: unknown): Promise<AgentRun> {
    return await asPerson(this.env, this.ctx.props, {
      allowed: () => true,
      method: "workflows.status",
      read: async (person, permissions) => {
        const found = await runStatus(this.env, person, run).catch(
          (error: unknown) => {
            throw hidden(error);
          }
        );
        if (!readsWorkflow(found.app, found.workflow)(permissions)) {
          throw notFound();
        }
        return agentRun(found, await appRestricted(this.env, found.app));
      },
      detail: (found) => ({ run: found.id }),
    });
  }
}

/** The types `env.workflows` returns, as the model reads them. */
const workflowsTypes = `/** A workflow run: its state, never what it returned. */
interface WorkflowRun {
  id: string;
  app: string;
  workflow: string;
  /** The App version it runs. */
  version: number;
  /** queued: waiting for a share of the attempts that run at once, not a fault. */
  status: "queued" | "running" | "waiting" | "paused" | "completed" | "failed" | "cancelled";
  /** A person started it, or a trigger did. */
  startedBy: { type: "person"; userId: string } | { type: "trigger" };
  createdAt: string;
  endedAt: string | null;
  /** Where it failed: the step (null outside one) and the error's code. */
  failure: { step: string | null; code: string } | null;
}`;

/** What the model reads of `env.workflows`. */
const workflowsDeclaration = `/** The workflows this chat may follow, and their runs. */
workflows: {
  /** The workflows this chat may read, with their latest run and counts. */
  list(): Promise<{
    app: string;
    appName: string;
    workflow: string;
    version: number;
    owner: { userId: string; name: string | null };
    lastRun: { id: string; status: string; createdAt: string } | null;
    /** Runs waiting for a decision now. */
    waiting: number;
    /** Runs that failed in the last 7 days. */
    failed: number;
    /** A schedule of it stopped: its run failed to start 8 times in a row. */
    scheduleStopped: boolean;
  }[]>;
  /** A workflow's runs: waiting first, then failed, then the newest, at most 100. */
  runs(app: string, workflow: string): Promise<WorkflowRun[]>;
  /** One run, as it is now. */
  status(run: string): Promise<WorkflowRun>;
  /**
   * Workflows the person may ask you to start for them: those they could
   * start themselves whose owners allow asking, each at the version a start
   * runs, with the JSON Schema its input must match. Only in a chat app
   * (Microsoft Teams); empty or refused elsewhere.
   */
  askable(): Promise<{ id: string; name: string; version: number; input: unknown }[]>;
  /**
   * Offers to start one of \`askable()\`'s workflows with \`input\`: a card
   * under your answer shows the person its values and a Start button. Nothing
   * starts until they press it; then it runs as them, and they are told here
   * when it ends. Offer only what they asked for, with values from what they
   * said; say in your answer that the card is there. At most 10 values,
   * shown whole. Refused in a chat that read restricted data.
   */
  offer(workflow: string, input: unknown): Promise<{ offer: string; workflow: string; version: number }>;
  /**
   * The independent workflows (env.workflowBuild) you may follow, of those
   * the person has a role in.
   */
  independent(): Promise<{ id: string; name: string; currentVersion: number | null; role: "user" | "builder" }[]>;
  /**
   * An independent workflow's runs, newest first, at most 50: every run
   * for its builders, the person's own for a user. Their state, never what
   * a run returned or why it failed.
   */
  independentRuns(workflow: string): Promise<{
    id: string;
    workflowId: string;
    version: number;
    status: "starting" | "running" | "completed" | "failed" | "cancelled";
    /** The person it acts for. */
    principal: string;
    createdAt: string;
    endedAt: string | null;
  }[]>;
};`;

/** `env.workflows`. */
export const workflowsApi: AgentApi = {
  name: "workflows",
  summary:
    "The workflows this chat may follow, and their runs. Offering a start starts nothing until the person presses it.",
  types: workflowsTypes,
  declaration: workflowsDeclaration,
  stub: (scope) => exports.WorkflowsApi({ props: scope }),
};
