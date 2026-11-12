import { isMemberAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { BotIcon } from "lucide-react";

import { AgentPage, agentTabOf } from "../agents/agent-page.tsx";
import type { AgentTab } from "../agents/agent-page.tsx";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { readManaged } from "./_shell.agents.index.tsx";

// One agent's page (agents/agent-page.tsx), for the company's own admins:
// anyone else is sent to the Agents page, where their agents open a chat.
// Its tab is in the address, so a link can lead to an agent's access or
// its schedule.

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
  const { managed, usable, people, models } = page.data;
  const agent = managed.agents.find(({ id }) => id === agentId);
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
  return (
    <>
      <SiteHeader crumbs={[...crumbs, { label: agent.name }]} />
      <AgentPage
        agent={agent}
        editable={isMemberAdmin(identity)}
        first={agent.id === managed.agents.at(0)?.id}
        key={agent.id}
        models={models}
        onTab={(next) => {
          void navigate({
            search: next === "overview" ? {} : { tab: next },
            replace: true,
          });
        }}
        people={people}
        settings={managed.settings[agent.id]}
        tab={agentTabOf(tab)}
        teams={managed.teams}
        usable={usable.some(({ id }) => id === agent.id)}
        wakes={managed.wakes[agent.id] ?? []}
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
  beforeLoad: ({ context: { identity } }) => {
    if (!isMemberAdmin(identity)) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/agents", replace: true });
    }
  },
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session) => {
      const [managed, usable] = await Promise.all([
        readManaged(session),
        session.chats.agents(),
      ]);
      // The models an agent can be given: none when core won't say, and
      // an agent then keeps the one it has.
      const [chosen] = await Promise.allSettled([session.chats.models()]);
      // The people a wake-up can work for: none when core won't say, and
      // the page still shows the agent.
      const [listed] = await Promise.allSettled([session.members.list()]);
      return {
        managed,
        usable,
        people: listed.status === "fulfilled" ? listed.value : [],
        models: chosen.status === "fulfilled" ? chosen.value : [],
      };
    }),
});
