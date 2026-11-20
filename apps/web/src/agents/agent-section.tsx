import { useLingui } from "@lingui/react/macro";
import { Link, useMatch } from "@tanstack/react-router";

import { AgentMark } from "../grasp/agent-mark/index.ts";
import { CalendarIcon, Lock, Note } from "../grasp/icons/index.ts";
import type { SidebarSection } from "../grasp/sidebar/index.ts";
import { wakesOn } from "./agent-facts.tsx";
import { agentTabOf } from "./agent-page.tsx";
import type { AgentTab } from "./agent-page.tsx";

// One agent as the sidebar's section while an admin is on its page, as
// Settings is (grasp/frame/grasp-sidebar.tsx): the agent's mark and name
// first, above Back, the press that opens its overview (the library's
// `home`, as the Brain has it); Back to the Agents page; then a row per
// other part of its page. The parts
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
  const row = (value: AgentTab, label: string, icon: typeof Note) => ({
    label,
    icon,
    render: (
      <Link
        // The Overview has no `tab`: counted as absent, so the router
        // doesn't mark it as the page on every other tab too.
        activeOptions={{ explicitUndefined: true }}
        params={{ agent: agent.id }}
        search={{ tab: value === "overview" ? undefined : value }}
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
    // Its name, above Back, opens its overview, as the Brain's does: no
    // Overview row of its own.
    home: (
      <Link
        params={{ agent: agent.id }}
        search={{ tab: undefined }}
        to="/agents/$agent"
      />
    ),
    homeCurrent: tab === "overview",
    back: { label: t`Back`, render: <Link to="/agents" /> },
    groups: [
      {
        rows: [
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
