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

// A new agent: anyone of the company makes one of their own, while the
// company lets them, and its own admins one for the company. Grasp's staff
// are sent to the Agents page, as core would refuse them the making, and
// so is anyone who may make neither kind. It starts by asking
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
  const { taken, models, apps, teams, ownOn } = Route.useLoaderData();
  const company = isMemberAdmin(identity);
  return (
    <>
      <SiteHeader
        crumbs={[{ label: t`Agents`, to: "/agents" }, { label: t`New agent` }]}
      />
      {way === undefined ? <NewAgentStart /> : null}
      {way === "manual" ? (
        <ManualAgent
          apps={apps}
          company={company}
          models={models}
          own={ownOn}
          personId={identity.userId}
          taken={taken}
          teams={teams}
        />
      ) : null}
      {way === "chat" ? (
        // The route has the whole card: the questions keep a page's room.
        <div {...stylex.props(styles.padded)}>
          <NewAgent
            company={company}
            own={ownOn}
            personId={identity.userId}
            taken={taken}
          />
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
    // Grasp's staff are no one of the company: they make neither kind.
    if (identity.staff) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/agents", replace: true });
    }
  },
  component: NewAgentPage,
  pendingComponent: NewAgentLoading,
  // What the setup offers, each none when core won't say: the names other
  // agents have, the company's and the person's own (core still refuses a
  // name in use), the models an agent can be given, the apps the company
  // offers, connected and working ones marked, and the company's teams.
  // Whether the company lets people have agents of their own: on when core
  // won't say, as core still refuses what it refuses.
  loader: async ({
    context: { core, identity },
  }): Promise<{
    taken: string[];
    models: string[];
    apps: CatalogApp[];
    teams: { teamId: string; name: string }[];
    ownOn: boolean;
  }> => {
    const [agents, own, models, connections, catalog, reach, setting] =
      await Promise.allSettled([
        core.withSession(async (session) => await session.connections.agents()),
        core.withSession(
          async (session) => await session.connections.ownAgents()
        ),
        core.withSession(async (session) => await session.chats.models()),
        core.withSession(async (session) => await session.connections.list()),
        core.withSession(
          async (session) => await session.connections.catalog()
        ),
        core.withSession(
          async (session) => await session.connections.stephenReach()
        ),
        core.withSession(
          async (session) => await session.orgSettings.ownAgents()
        ),
      ]);
    const ownOn = setting.status === "fulfilled" ? setting.value.on : true;
    // Someone who may make neither kind has nothing to make here.
    if (!ownOn && !isMemberAdmin(identity)) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/agents", replace: true });
    }
    // An agent is given only an app the company offers.
    const entries =
      catalog.status === "fulfilled"
        ? catalog.value.entries.filter(({ offered }) => offered)
        : [];
    const working =
      connections.status === "fulfilled"
        ? connections.value.filter(({ status }) => status === "active")
        : [];
    // The catalog's apps, the connected ones marked with the account they use.
    const apps = entries.map((entry) => {
      const connection = working.find(({ provider }) => provider === entry.id);
      return {
        id: entry.id,
        source: entry.source,
        name: entry.name,
        logo: entry.logo,
        description: entry.description,
        categories: entry.categories,
        connected: connection !== undefined,
        account: connection?.accountName ?? null,
      };
    });
    return {
      taken: [agents, own].flatMap((read) =>
        read.status === "fulfilled" ? read.value.map(({ name }) => name) : []
      ),
      models: models.status === "fulfilled" ? models.value : [],
      apps,
      teams: reach.status === "fulfilled" ? reach.value.teams : [],
      ownOn,
    };
  },
});
