import type { AgentSettings, AgentWake } from "@grasp-os/shared/agents";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { AgentsOverview } from "../agents/agents-overview.tsx";
import type { ManagedAgents } from "../agents/agents-overview.tsx";
import type { Session } from "../core.ts";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// The Agents page (agents/agents-overview.tsx): the agents the person may
// talk to (`chats.agents`), and for the company's own admins every agent
// with what core keeps of it. Only admins read the rest, as core checks
// on every call; the first agent's reach is Settings › Stephen's, so only
// the others' is read here.

/** What an admin reads of every agent: its reach, its classes and its wake-ups. */
export const readManaged = async (session: Session): Promise<ManagedAgents> => {
  const [agents, reach] = await Promise.all([
    session.connections.agents(),
    session.connections.stephenReach(),
  ]);
  const settings = await Promise.all(
    agents
      .slice(1)
      .map(async ({ id }): Promise<[string, AgentSettings]> => [
        id,
        await session.connections.agentSettings(id),
      ])
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
    teams: reach.teams,
  };
};

const AgentsPage = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  if (page.state !== "ready") {
    return <PageNotLoaded crumbs={[{ label: t`Agents` }]} page={page} />;
  }
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Agents` }]} />
      <AgentsOverview managed={page.data.managed} usable={page.data.usable} />
    </>
  );
};

export const Route = createFileRoute("/_shell/agents/")({
  pendingComponent: PageLoading,
  component: AgentsPage,
  loader: async ({ context: { core, identity } }) =>
    await loadFromCore(core, async (session) => {
      const [usable, managed] = await Promise.all([
        session.chats.agents(),
        isMemberAdmin(identity) ? readManaged(session) : undefined,
      ]);
      return { usable, managed };
    }),
});
