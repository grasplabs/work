import type { AgentSettings, AgentWake } from "@grasp-os/shared/agents";
import { isAdmin, isMemberAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import {
  AgentsOverview,
  AgentTabsWaiting,
  agentsTabOf,
} from "../agents/agents-overview.tsx";
import type { AgentsTab, ManagedAgents } from "../agents/agents-overview.tsx";
import type { Session } from "../core.ts";
import { PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { PageSkeletonAgents } from "../grasp/blocks/page-skeleton-agents/page-skeleton-agents.tsx";
import { Button } from "../grasp/button/index.ts";
import { Plus } from "../grasp/icons/index.ts";
import { loadFromCore } from "../load-from-core.tsx";

// The Agents page (agents/agents-overview.tsx): the agents the person may
// talk to (`chats.agents`), their own (`connections.ownAgents`), and for
// the company's own admins every agent of the company
// with what core keeps of it. Only admins read the rest, as core checks
// on every call; the first agent's reach is Settings › Stephen's, so only
// the others' is read here. The tab an admin is on is in the address
// (`?tab=`), so a link or a reload leads back to it.

/** What an admin reads of every agent: its reach, its classes and its wake-ups. */
export const readManaged = async (session: Session): Promise<ManagedAgents> => {
  // What each used this month: none when core won't say, and the pages
  // then show the agents without it. Read beside the agents, not after.
  const [[agents, reach], [used]] = await Promise.all([
    Promise.all([
      session.connections.agents(),
      session.connections.stephenReach(),
    ]),
    Promise.allSettled([session.connections.agentsUsage()]),
  ]);
  // Each other agent's reach and classes: none for one core won't say
  // them of, as it won't for Grasp's staff.
  const read = await Promise.allSettled(
    agents
      .slice(1)
      .map(async ({ id }): Promise<[string, AgentSettings]> => [
        id,
        await session.connections.agentSettings(id),
      ])
  );
  const settings = read.flatMap((each) =>
    each.status === "fulfilled" ? [each.value] : []
  );
  // Each agent's wake-ups: none for one core won't say them of.
  const wakes = await Promise.all(
    agents.map(async ({ id }): Promise<[string, AgentWake[]]> => {
      const [woken] = await Promise.allSettled([
        session.connections.agentWakes(id),
      ]);
      return [id, woken.status === "fulfilled" ? woken.value : []];
    })
  );
  return {
    agents,
    settings: Object.fromEntries(settings),
    wakes: Object.fromEntries(wakes),
    usage: Object.fromEntries(
      (used.status === "fulfilled" ? used.value : []).map((usage) => [
        usage.agentId,
        usage,
      ])
    ),
    teams: reach.teams,
  };
};

/**
 * The agents people offered the company, and the people to name them by:
 * none where core won't say them, and the page still shows the rest.
 */
const readOffered = async (session: Session) => {
  const [agents, people] = await Promise.allSettled([
    session.connections.offeredAgents(),
    session.members.list(),
  ]);
  return {
    agents: agents.status === "fulfilled" ? agents.value : [],
    people: people.status === "fulfilled" ? people.value : [],
  };
};

const AgentsPage = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { identity } = Route.useRouteContext();
  if (page.state !== "ready") {
    return <PageNotLoaded crumbs={[{ label: t`Agents` }]} page={page} />;
  }
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Agents` }]} />
      <AgentsOverview
        makes={isMemberAdmin(identity)}
        makesOwn={!identity.staff && page.data.ownOn}
        managed={page.data.managed}
        offered={page.data.offered}
        onTab={(chosen) => {
          // In place of the address it leaves: Back goes to the page before Agents.
          void navigate({ search: { tab: chosen }, replace: true });
        }}
        own={page.data.own}
        tab={tab}
        usable={page.data.usable}
      />
    </>
  );
};

/**
 * The Agents page before its agents arrive: its crumbs, then the library's
 * agents skeleton, its grid of portrait cards on the page's own paper, with
 * New agent in its place for whoever may make one: anyone but Grasp's
 * staff, as people may make their own until an admin turns that off
 * (`ownAgentsDefault`), which the page knows only once it has loaded. The
 * tabs stand in their place for the company's admins, who have them on the
 * loaded page.
 */
const AgentsLoading = () => {
  const { t } = useLingui();
  const { identity } = Route.useRouteContext();
  const { tab } = Route.useSearch();
  // As the loader reads it: whoever gets the tabs on the loaded page.
  const admin = isAdmin(identity.role);
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Agents` }]} />
      <PageSkeletonAgents
        actions={
          identity.staff ? undefined : (
            <Button icon={Plus} variant="ink">
              {t`New agent`}
            </Button>
          )
        }
        cards={4}
        toolbar={admin ? <AgentTabsWaiting tab={tab} /> : undefined}
      />
    </>
  );
};

export const Route = createFileRoute("/_shell/agents/")({
  pendingComponent: AgentsLoading,
  component: AgentsPage,
  validateSearch: (
    search: Record<string, unknown>
  ): { tab?: AgentsTab | undefined } => {
    const tab = agentsTabOf(search.tab);
    return tab === undefined ? {} : { tab };
  },
  loader: async ({ context: { core, identity } }) =>
    await loadFromCore(core, async (session) => {
      const admin = isAdmin(identity.role);
      const [usable, own, setting, managed, offered] = await Promise.all([
        session.chats.agents(),
        // The person's own, which nobody else is ever listed.
        session.connections.ownAgents(),
        session.orgSettings.ownAgents(),
        // Admins, Grasp's staff among them, who read and change nothing.
        admin ? readManaged(session) : undefined,
        admin ? readOffered(session) : undefined,
      ]);
      return {
        usable,
        own,
        ownOn: setting.on,
        managed,
        offered,
      };
    }),
});
