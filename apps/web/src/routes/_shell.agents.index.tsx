import type { AgentSettings, AgentWake } from "@grasp-os/shared/agents";
import { isAdmin, isMemberAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { AgentsOverview } from "../agents/agents-overview.tsx";
import type { ManagedAgents } from "../agents/agents-overview.tsx";
import type { OwnAgentsAdmin } from "../agents/own-agents-admin.tsx";
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
 * What an admin reads of people's own agents beside the switch: what
 * each person's cost, and the people to name them by. Either is left out
 * where core won't say it, and the page still shows the rest.
 */
const readOwnAdmin = async (
  session: Session
): Promise<Omit<OwnAgentsAdmin, "on">> => {
  const [usage, people] = await Promise.allSettled([
    session.connections.ownAgentsUsage(),
    session.members.list(),
  ]);
  return {
    usage: usage.status === "fulfilled" ? usage.value : undefined,
    people: people.status === "fulfilled" ? people.value : undefined,
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
        makesOwn={!identity.staff && page.data.ownOn}
        managed={page.data.managed}
        ownAdmin={page.data.ownAdmin}
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
      const [usable, own, setting, managed, ownAdmin] = await Promise.all([
        session.chats.agents(),
        // The person's own, which nobody else is ever listed.
        session.connections.ownAgents(),
        session.orgSettings.ownAgents(),
        // Admins, Grasp's staff among them, who read and change nothing.
        admin ? readManaged(session) : undefined,
        admin ? readOwnAdmin(session) : undefined,
      ]);
      return {
        usable,
        own,
        ownOn: setting.on,
        managed,
        ownAdmin:
          ownAdmin === undefined ? undefined : { ...ownAdmin, on: setting.on },
      };
    }),
});
