import type { AgentSettings, AgentWake } from "@grasp-os/shared/agents";
import { isAdmin, isMemberAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { AgentsOverview } from "../agents/agents-overview.tsx";
import type { ManagedAgents } from "../agents/agents-overview.tsx";
import type { Session } from "../core.ts";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// The Agents page (agents/agents-overview.tsx): the agents the person may
// talk to (`chats.agents`), their own (`connections.ownAgents`), and for
// the company's own admins every agent of the company
// with what core keeps of it. Only admins read the rest, as core checks
// on every call; the first agent's reach is Settings › Stephen's, so only
// the others' is read here.

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
  const { identity } = Route.useRouteContext();
  if (page.state !== "ready") {
    return <PageNotLoaded crumbs={[{ label: t`Agents` }]} page={page} />;
  }
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Agents` }]} />
      <AgentsOverview
        makes={isMemberAdmin(identity)}
        makesOwn={!identity.staff}
        managed={page.data.managed}
        offered={page.data.offered}
        own={page.data.own}
        usable={page.data.usable}
      />
    </>
  );
};

export const Route = createFileRoute("/_shell/agents/")({
  pendingComponent: PageLoading,
  component: AgentsPage,
  loader: async ({ context: { core, identity } }) =>
    await loadFromCore(core, async (session) => {
      const admin = isAdmin(identity.role);
      const [usable, own, managed, offered] = await Promise.all([
        session.chats.agents(),
        // The person's own, which nobody else is ever listed.
        session.connections.ownAgents(),
        // Admins, Grasp's staff among them, who read and change nothing.
        admin ? readManaged(session) : undefined,
        admin ? readOffered(session) : undefined,
      ]);
      return { usable, own, managed, offered };
    }),
});
