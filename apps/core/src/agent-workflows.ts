import type { Permission } from "@grasp-os/shared/permissions";
import type {
  WorkflowRole,
  WorkflowRunStatus,
} from "@grasp-os/shared/workflow-resources";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { WorkerEntrypoint, exports } from "cloudflare:workers";

import { asPerson } from "./agent-person.ts";
import { admitEffect } from "./agent-scope.ts";
import type { AgentApi, AgentScope } from "./agent-scope.ts";
import { askableFor } from "./channels/askable-workflows.ts";
import type { AskableWorkflow } from "./channels/askable-workflows.ts";
import { holdStart } from "./held-starts.ts";
import type { AgentStart } from "./held-starts.ts";
import { listWorkflowResources } from "./workflow-resources.ts";
import { listResourceRuns } from "./workflows/resource-runs.ts";

// Workflows for a chat's code: `await env.workflows.independentRuns(id)`.
// What the chat's person sees of them themselves (agent-person.ts), of the
// independent workflows the agent may follow (`followsWorkflow`). The
// agent sees runs' state here, never what a run returned or its error's
// words: those hold what the run read through its connections, which the
// chat has no permission for. Every call is audited as the organization's
// agent acting for the chat's person.
//
// In a chat app's chat, the agent may also offer to start a workflow whose
// owner lets people ask for it (`askable`, `offer`): it lists those the
// person could start themselves and puts one, with its values, on a card;
// only the person's press starts it, as them (channels/workflow-offers.ts).
// The owner's choice to open it to asking is what lets the agent see it:
// no permission of the agent's reaches further, and nothing it offers runs
// without the press.
//
// The agent may also ask to start an independent workflow itself
// (`start`, platform specification 15.1), through the one start contract
// and receipt every start has (workflow-starts.ts). Its start waits for
// its person to confirm it in Grasp (held-starts.ts), as a change an
// agent makes always does. Threat model, and how each is closed:
//
// - A start nothing the person said asked for (an instruction read from a
//   mail, a page, a file): the agent's start only holds; the run starts
//   once the person confirms it, in their own session. In a chat app's
//   chat, where Grasp shows nothing to confirm, the agent offers the
//   start on a card instead (`offer`), which only the person's press
//   starts (`workflow.start_offer_only`).
// - An agent starting what it wasn't given: holding it, and starting it,
//   need the agent's own active `start` grant on the workflow, in this
//   chat's workspace, which only an admin gives.
// - An agent lending its person more than they have: the run acts for the
//   chat's person, who must have a role in the workflow themselves, read
//   again as the start is admitted: the agent's grant and the person's
//   role, intersected, never either alone.
// - A start held or run twice: the agent names a key of its own, which
//   core scopes to the chat; the same key in the chat is the same held
//   start, and its run the same run.
// - Restricted data carried into a run: a chat that read restricted data
//   starts a restricted run, for good (`restrictedStart`).
// - A start nobody can trace: every call is audited as the agent acting
//   for its person (`agent.call`), holding as `workflow.start.held`,
//   the person's decision as theirs, and the start as
//   `workflow.start.admitted` with the agent as its delegate actor.
// - A code run that ended, or lost a revocation, still asking: the write
//   is admitted against the chat's open code run before it is held
//   (`admitEffect`).

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
 * state, never what it returned or why it failed.
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

/** Workflows, as a chat's code reads them. */
export class WorkflowsApi extends WorkerEntrypoint<Env, AgentScope> {
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
        if (via === undefined || via === "web") {
          return [];
        }
        return await askableFor(this.env, person);
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
      read: async (person) => {
        // The offer's card brings the Chat SDK, which core loads when first
        // used, not as it starts (GRA-1349).
        const { offerStart } = await import("./channels/workflow-offers.ts");
        return await offerStart(
          this.env,
          this.ctx.props,
          person,
          workflow,
          input
        );
      },
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

  /**
   * Asks to start independent workflow `workflow` with `input`, as the
   * agent acting for the chat's person, under `key`: held until the person
   * confirms it in Grasp. The same key in the chat answers where that
   * start stands. Refused in a chat app's chat, where it is offered.
   */
  async start(
    workflow: unknown,
    input: unknown,
    key: unknown
  ): Promise<AgentStart> {
    return await asPerson(this.env, this.ctx.props, {
      // Its own `start` grant on the workflow is read as the start is
      // decided, held and admitted (workflow-starts.ts).
      allowed: () => true,
      action: "write",
      method: "workflows.start",
      read: async (person) => {
        const scope = this.ctx.props;
        if (scope.via !== undefined && scope.via !== "web") {
          throw workflowResourceErrors.create("workflow.start_offer_only");
        }
        await admitEffect(this.env, scope);
        return await holdStart(this.env, scope, person, workflow, input, key);
      },
      detail: (standing) => ({
        workflow: standing.workflow,
        version: standing.version,
        held: standing.held,
        status: standing.status,
      }),
    });
  }
}

/** What the model reads of `env.workflows`. */
const workflowsDeclaration = `/** The workflows this chat may follow, and their runs. */
workflows: {
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
  /**
   * Asks to start independent workflow \`workflow\` (its ID) with \`input\`,
   * as the person you act for, at its current version. Nothing runs yet: it
   * waits for them to confirm it in Grasp, and \`status\` says "waiting";
   * say in your answer that it waits for them. Call again with the same
   * \`key\` to see where it stands ("started"; "refused", with why, when
   * your grant or their access went before it started; "declined"; "lapsed"),
   * never with a new key for the same start. Only once an admin granted you
   * \`start\` on it, and only one the person could start themselves. In a
   * chat app (Microsoft Teams, Slack) it is refused: use \`offer\` there.
   * Ask only for what the person asked for.
   */
  start(workflow: string, input: unknown, key: string): Promise<
    | { status: "waiting"; held: string; workflow: string; version: number; expiresAt: string }
    | { status: "started"; held: string; workflow: string; version: number; start: string }
    | { status: "refused"; held: string; workflow: string; version: number; code: string }
    | { status: "declined" | "lapsed"; held: string; workflow: string; version: number }
  >;
};`;

/** `env.workflows`. */
export const workflowsApi: AgentApi = {
  name: "workflows",
  summary:
    "The workflows this chat may follow, and their runs. Offering a start starts nothing until the person presses it; starting one yourself waits for the person to confirm it in Grasp.",
  declaration: workflowsDeclaration,
  stub: (scope) => exports.WorkflowsApi({ props: scope }),
};
