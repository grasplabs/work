import { isAdmin, isMemberAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { BotIcon } from "lucide-react";

import { AgentPage, agentTabOf } from "../agents/agent-page.tsx";
import type { AgentTab, FirstAgentAccess } from "../agents/agent-page.tsx";
import type { Session } from "../core.ts";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore, orNull } from "../load-from-core.tsx";
import { readManaged } from "./_shell.agents.index.tsx";

// One agent's page (agents/agent-page.tsx): one of the company's for its
// admins, or the person's own for them alone. Anyone else is sent to the
// Agents page, where the company's agents open a chat.
// Its tab is in the address, so a link can lead to an agent's access or
// its schedule.

/**
 * The first agent's access, as Settings › Stephen read it: its reach and
 * the company's classes, with how it is doing and the workflows people
 * start by asking it, each of those two read on its own so the rest
 * shows when either can't be.
 */
const readFirstAccess = async (session: Session): Promise<FirstAgentAccess> => {
  const [reach, classes, week, workflows] = await Promise.all([
    session.connections.stephenReach(),
    session.connections.toolClasses(),
    orNull(async () => await session.stephenRequests.week()),
    orNull(async () => await session.workflowResources.askableWorkflows()),
  ]);
  return { reach, classes, week, workflows };
};

const AgentRoutePage = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { tab } = Route.useSearch();
  const { agent: agentId } = Route.useParams();
  const { identity } = Route.useRouteContext();
  const navigate = Route.useNavigate();
  const crumbs = [{ label: t`Agents`, to: "/agents" as const }];
  if (page.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={[...crumbs, { label: t`Agent` }]}
        icon={BotIcon}
        notFound={t`Agent not found`}
        page={page}
      />
    );
  }
  if (page.data === null) {
    // Never shown: the loader leads such a read to the Agents page.
    return null;
  }
  const { managed, own, usable, people, models, firstAccess, documents } =
    page.data;
  const agent =
    own.find(({ id }) => id === agentId) ??
    managed?.agents.find(({ id }) => id === agentId);
  if (agent === undefined) {
    return (
      <PageNotLoaded
        crumbs={[...crumbs, { label: t`Agent` }]}
        icon={BotIcon}
        notFound={t`Agent not found`}
        page={{ state: "missing" }}
      />
    );
  }
  const mine = agent.ownerId !== null;
  return (
    <>
      <SiteHeader crumbs={[...crumbs, { label: agent.name }]} />
      <AgentPage
        agent={agent}
        documents={documents}
        editable={mine || isMemberAdmin(identity)}
        first={!mine && agent.id === managed?.agents.at(0)?.id}
        key={agent.id}
        models={models}
        onTab={(next) => {
          void navigate({
            search: next === "overview" ? {} : { tab: next },
            replace: true,
          });
        }}
        people={people}
        settings={managed?.settings[agent.id]}
        tab={agentTabOf(tab)}
        teams={managed?.teams ?? []}
        usable={usable.some(({ id }) => id === agent.id)}
        usage={managed?.usage[agent.id]}
        firstAccess={firstAccess}
        wakes={managed?.wakes[agent.id] ?? []}
      />
    </>
  );
};

export const Route = createFileRoute("/_shell/agents/$agent")({
  pendingComponent: PageLoading,
  component: AgentRoutePage,
  validateSearch: (
    search: Record<string, unknown>
  ): { tab?: AgentTab | undefined } =>
    search.tab === undefined ? {} : { tab: agentTabOf(search.tab) },
  loader: async ({ context: { core, identity }, params }) => {
    const page = await loadFromCore(core, async (session) => {
      const [own, usable] = await Promise.all([
        session.connections.ownAgents(),
        session.chats.agents(),
      ]);
      const mine = own.some(({ id }) => id === params.agent);
      // The company's agents are its admins' to read, Grasp's staff
      // among them, who change nothing. Anyone else has only their own:
      // any other ID leads to the Agents page.
      if (!mine && !isAdmin(identity.role)) {
        return null;
      }
      const managed = mine ? undefined : await readManaged(session);
      // The models an agent can be given: none when core won't say, and
      // an agent then keeps the one it has.
      const [chosen] = await Promise.allSettled([session.chats.models()]);
      // The people a wake-up can work for: none when core won't say, and
      // the page still shows the agent.
      const [listed] = await Promise.allSettled([session.members.list()]);
      // The agent's documents: not shown when core won't say, and the
      // page still shows the agent.
      const [kept] = await Promise.allSettled([
        session.connections.agentDocuments(params.agent),
      ]);
      return {
        managed,
        own,
        usable,
        people: listed.status === "fulfilled" ? listed.value : [],
        models: chosen.status === "fulfilled" ? chosen.value : [],
        documents: kept.status === "fulfilled" ? kept.value : undefined,
        firstAccess:
          managed !== undefined && params.agent === managed.agents.at(0)?.id
            ? await readFirstAccess(session)
            : undefined,
      };
    });
    if (page.state === "ready" && page.data === null) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/agents", replace: true });
    }
    return page;
  },
});
