import { delegateActorOf } from "@grasp-os/shared/audit";
import { WorkerEntrypoint, exports } from "cloudflare:workers";

import { asPerson } from "./agent-person.ts";
import { admitEffect, chatAuthority } from "./agent-scope.ts";
import type { AgentApi, AgentScope } from "./agent-scope.ts";
import { dashboardWork, makeWidget } from "./dashboard-widgets.ts";
import { workspace } from "./durable-objects.ts";
import { personalWorkspaceId } from "./personal-workspace.ts";

// The person's dashboard widgets, from a chat: `await
// env.dashboard.makeWidget({ request })`, as the prototype's chat tools
// `make_widget` and `change_widget`. The same path as on the dashboard
// (dashboard-widgets.ts): made from the person's own rows, through the
// model gateway on their budget, recorded as the chat's agent acting for
// them. The agent hands over what was asked and gets back only the
// widget's ID: the widget, its title and what the model said of it are
// written from the names of the person's engines and workflows, which the
// agent may hold no permission to read, so they stay on the dashboard.

/** A widget Grasp made for the person, as the chat's agent knows it. */
export interface AgentWidget {
  id: string;
  /** What the person asked of it last, in their words. */
  asked: string;
}

/** The person's dashboard widgets, as a chat's code asks for them. */
export class DashboardApi extends WorkerEntrypoint<Env, AgentScope> {
  /** The widgets Grasp made for the person. */
  async widgets(): Promise<AgentWidget[]> {
    const scope = this.ctx.props;
    return await asPerson(this.env, scope, {
      allowed: () => true,
      method: "dashboard.widgets",
      read: async (person) => {
        const kept = await workspace(
          this.env,
          personalWorkspaceId(person.userId)
        ).customWidgets(person.userId);
        return kept.map(({ id, asked }) => ({ id, asked }));
      },
      detail: (listed) => ({ widgets: listed.length }),
    });
  }

  /** Makes a widget as the person asked, last on their dashboard. */
  async makeWidget(input: unknown): Promise<AgentWidget> {
    return await this.#make("dashboard.makeWidget", input);
  }

  /** Changes widget `id` as the person asked; it keeps its place. */
  async changeWidget(input: unknown): Promise<AgentWidget> {
    const id =
      typeof input === "object" && input !== null && "id" in input
        ? input.id
        : undefined;
    return await this.#make("dashboard.changeWidget", input, id ?? "");
  }

  async #make(
    method: string,
    input: unknown,
    changing?: unknown
  ): Promise<AgentWidget> {
    const scope = this.ctx.props;
    const request =
      typeof input === "object" && input !== null && "request" in input
        ? input.request
        : undefined;
    return await asPerson(this.env, scope, {
      allowed: () => true,
      action: "write",
      method,
      read: async (person) => {
        await admitEffect(this.env, scope, method);
        const { widget } = await makeWidget(
          this.env,
          {
            member: person,
            trigger: delegateActorOf(chatAuthority(scope)),
            work: dashboardWork,
            requestId: crypto.randomUUID(),
          },
          request,
          changing
        );
        return { id: widget.id, asked: widget.asked };
      },
      detail: ({ id }) => ({ widget: id }),
    });
  }
}

/** What the model reads of `env.dashboard`. */
const dashboardDeclaration = `/** The person's dashboard in Grasp: widgets Grasp makes from what they ask, drawn from their own workflows' numbers. */
dashboard: {
  /** The widgets made for them so far, with what they asked of each last. */
  widgets(): Promise<{ id: string; asked: string }[]>;
  /**
   * Makes a widget from what the person asked, in their words or yours (at
   * most 500 characters): what it should show of their workflows and runs.
   * It goes last on their dashboard; tell them it is there. Refused when the
   * request can't be made into a widget: ask them to say it another way.
   */
  makeWidget(input: { request: string }): Promise<{ id: string; asked: string }>;
  /** Changes widget \`id\` as asked; it keeps its place on the dashboard. */
  changeWidget(input: { id: string; request: string }): Promise<{ id: string; asked: string }>;
};`;

/** `env.dashboard`. */
export const dashboardApi: AgentApi = {
  name: "dashboard",
  summary:
    "The person's dashboard: make or change a widget of their workflows' numbers from what they ask.",
  declaration: dashboardDeclaration,
  stub: (scope) => exports.DashboardApi({ props: scope }),
};
