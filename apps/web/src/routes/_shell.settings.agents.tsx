import type { AgentSettings, AgentWake } from "@grasp-os/shared/agents";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { AgentsSettings } from "../settings/agents-settings.tsx";
import {
  SettingsError,
  SettingsLoading,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// Settings › Agents, for admins: the company's agents, whom each answers
// and what each may do (settings/agents-settings.tsx). The first agent's
// reach is Settings › Stephen's, so only the others' are read here; the
// teams an audience may name come with Settings › Stephen's read. Only
// the company's own admins read and change it, as core checks on every
// call.

const AgentsPage = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  if (page.state !== "ready") {
    return (
      <SettingsSection title={t`Agents`}>
        <NotLoadedState heading="h3" page={page} />
      </SettingsSection>
    );
  }
  return (
    <AgentsSettings
      agents={page.data.agents}
      editable={isMemberAdmin(identity)}
      people={page.data.people}
      settings={page.data.settings}
      teams={page.data.teams}
      wakes={page.data.wakes}
    />
  );
};

export const Route = createFileRoute("/_shell/settings/agents")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: AgentsPage,
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session) => {
      const [agents, reach, people] = await Promise.all([
        session.connections.agents(),
        session.connections.stephenReach(),
        session.members.list(),
      ]);
      // Every agent but the first, whose reach is Settings › Stephen's.
      const others = agents.slice(1);
      const read = await Promise.all(
        others.map(async ({ id }): Promise<[string, AgentSettings]> => [
          id,
          await session.connections.agentSettings(id),
        ])
      );
      const wakes = await Promise.all(
        agents.map(async ({ id }): Promise<[string, AgentWake[]]> => [
          id,
          await session.connections.agentWakes(id),
        ])
      );
      return {
        agents,
        settings: Object.fromEntries(read),
        teams: reach.teams,
        wakes: Object.fromEntries(wakes),
        people,
      };
    }),
});
