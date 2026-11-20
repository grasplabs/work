import { isMemberAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { agentTemplates } from "../agents/agent-templates.ts";
import { ManualAgent } from "../agents/manual-agent.tsx";
import { NewAgentStart, newAgentWayOf } from "../agents/new-agent-start.tsx";
import type { NewAgentWay } from "../agents/new-agent-start.tsx";
import { NewAgent } from "../agents/new-agent.tsx";
import type { CatalogApp } from "../agents/setup/model.ts";
import { SiteHeader } from "../frame/site-header.tsx";
import { PageSkeletonChoice } from "../grasp/blocks/page-skeleton-choice/page-skeleton-choice.tsx";
import { PageSkeletonQuestion } from "../grasp/blocks/page-skeleton-question/page-skeleton-question.tsx";
import { PageSkeletonSetup } from "../grasp/blocks/page-skeleton-setup/page-skeleton-setup.tsx";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// A new agent, for the company's own admins: anyone else is sent to the
// Agents page, as core would refuse them the making. It starts by asking
// which way (agents/new-agent-start.tsx): set up by hand
// (agents/manual-agent.tsx), or in a chat
// (agents/new-agent.tsx).

const styles = stylex.create({
  padded: {
    paddingInline: grasp.shellPageInline,
    paddingBlock: grasp.space7,
  },
});

const NewAgentPage = () => {
  const { t } = useLingui();
  const { identity } = Route.useRouteContext();
  const { way } = Route.useSearch();
  const { taken, models, apps, teams } = Route.useLoaderData();
  return (
    <>
      <SiteHeader
        crumbs={[{ label: t`Agents`, to: "/agents" }, { label: t`New agent` }]}
      />
      {way === undefined ? <NewAgentStart /> : null}
      {way === "manual" ? (
        <ManualAgent
          apps={apps}
          models={models}
          personId={identity.userId}
          taken={taken}
          teams={teams}
        />
      ) : null}
      {way === "chat" ? (
        // The route has the whole card: the questions keep a page's room.
        <div {...stylex.props(styles.padded)}>
          <NewAgent personId={identity.userId} taken={taken} />
        </div>
      ) : null}
    </>
  );
};

/**
 * New agent before what it offers arrives: its crumbs, then the library's
 * skeleton for the way shown: the choice of two ways, the guided setup, or
 * the questions of a chat.
 */
const NewAgentLoading = () => {
  const { t } = useLingui();
  const { way } = Route.useSearch();
  if (way === "chat") {
    // In a chat: the library's question skeleton, as its first question stands.
    return (
      <>
        <SiteHeader
          crumbs={[
            { label: t`Agents`, to: "/agents" },
            { label: t`New agent` },
          ]}
        />
        <div {...stylex.props(styles.padded)}>
          <PageSkeletonQuestion
            choices={agentTemplates.length}
            question={t`What should the agent do? Pick a starting point or say it in your own words.`}
            step={{ index: 0, count: 7 }}
            submitLabel={t`Next`}
          />
        </div>
      </>
    );
  }
  const crumbs = (
    <SiteHeader
      crumbs={[{ label: t`Agents`, to: "/agents" }, { label: t`New agent` }]}
    />
  );
  if (way === "manual") {
    // Set up by hand: the library's setup skeleton, its first question.
    return (
      <>
        {crumbs}
        <PageSkeletonSetup question={t`What should we call your agent?`} />
      </>
    );
  }
  // The first question: the library's choice skeleton, its two ways.
  return (
    <>
      {crumbs}
      <PageSkeletonChoice
        heading={t`How do you want to make it?`}
        line={t`You can change everything later.`}
      />
    </>
  );
};

export const Route = createFileRoute("/_shell/agents/new")({
  // The setup has the whole card, edge to edge on its backdrop, and no
  // chat box at its foot: it is a task of its own (Ruben, 19 Nov 2026).
  staticData: { page: "whole", dock: false },
  validateSearch: (
    search: Record<string, unknown>
  ): { way?: NewAgentWay | undefined } => {
    const way = newAgentWayOf(search.way);
    return way === undefined ? {} : { way };
  },
  beforeLoad: ({ context: { identity } }) => {
    if (!isMemberAdmin(identity)) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/agents", replace: true });
    }
  },
  component: NewAgentPage,
  pendingComponent: NewAgentLoading,
  // What the setup offers, each none when core won't say: the names other
  // agents have (core still refuses a name in use), the models an agent
  // can be given, the apps connected and working, and the company's teams.
  loader: async ({
    context: { core },
  }): Promise<{
    taken: string[];
    models: string[];
    apps: CatalogApp[];
    teams: { teamId: string; name: string }[];
  }> => {
    const [agents, models, connections, catalog, reach] =
      await Promise.allSettled([
        core.withSession(async (session) => await session.connections.agents()),
        core.withSession(async (session) => await session.chats.models()),
        core.withSession(async (session) => await session.connections.list()),
        core.withSession(
          async (session) => await session.connections.catalog()
        ),
        core.withSession(
          async (session) => await session.connections.stephenReach()
        ),
      ]);
    const entries = catalog.status === "fulfilled" ? catalog.value.entries : [];
    const working =
      connections.status === "fulfilled"
        ? connections.value.filter(({ status }) => status === "active")
        : [];
    // The catalog's apps, the connected ones marked with the account they use.
    const apps = entries.map((entry) => {
      const connection = working.find(({ provider }) => provider === entry.id);
      return {
        id: entry.id,
        name: entry.name,
        logo: entry.logo,
        description: entry.description,
        categories: entry.categories,
        connected: connection !== undefined,
        account: connection?.accountName ?? null,
      };
    });
    return {
      taken:
        agents.status === "fulfilled"
          ? agents.value.map(({ name }) => name)
          : [],
      models: models.status === "fulfilled" ? models.value : [],
      apps,
      teams: reach.status === "fulfilled" ? reach.value.teams : [],
    };
  },
});
