import { useLingui } from "@lingui/react/macro";
import { Link, useMatch } from "@tanstack/react-router";

import { AgentMark } from "../grasp/agent-mark/index.ts";
import { CalendarIcon, Info, Lock, Note } from "../grasp/icons/index.ts";
import type { SidebarSection } from "../grasp/sidebar/index.ts";
import { wakesOn } from "./agent-facts.tsx";
import { agentTabOf } from "./agent-page.tsx";
import type { AgentTab } from "./agent-page.tsx";

// One agent as the sidebar's section while an admin is on its page, as
// Settings is (grasp/frame/grasp-sidebar.tsx): Back to the Agents page,
// the agent's mark and name, then a row per part of its page. The parts
// are its page's tabs, kept in the address (`?tab=`), so a row is a link
// the page reads. What it shows is what the agent's route read: no read
// of its own.

/** The agent's page, as the sidebar's section; undefined anywhere else. */
export const useAgentSection = (): SidebarSection | undefined => {
  const { t } = useLingui();
  const match = useMatch({
    from: "/_shell/agents/$agent",
    shouldThrow: false,
  });
  if (match === undefined) {
    return undefined;
  }
  const page = match.loaderData;
  const agentId = match.params.agent;
  const agent =
    page?.state === "ready"
      ? page.data.managed.agents.find(({ id }) => id === agentId)
      : undefined;
  // Until the agent is read, and for one that isn't there: the page says so.
  if (page?.state !== "ready" || agent === undefined) {
    return undefined;
  }
  const { name } = agent;
  const tab = agentTabOf(match.search.tab);
  const scheduled = wakesOn(page.data.managed.wakes[agent.id] ?? []).length;
  const row = (value: AgentTab, label: string, icon: typeof Info) => ({
    label,
    icon,
    render: (
      <Link
        params={{ agent: agent.id }}
        search={value === "overview" ? {} : { tab: value }}
        to="/agents/$agent"
      />
    ),
    current: tab === value,
  });
  return {
    id: "agent",
    title: name,
    mark: <AgentMark name={name} size="xs" />,
    navLabel: t`${name}'s pages`,
    back: { label: t`Agents`, render: <Link to="/agents" /> },
    groups: [
      {
        rows: [
          row("overview", t`Overview`, Info),
          row("instructions", t`Instructions`, Note),
          row("access", t`Access`, Lock),
          {
            ...row("schedule", t`Schedule`, CalendarIcon),
            ...(scheduled === 0 ? {} : { count: scheduled }),
          },
        ],
      },
    ],
  };
};
