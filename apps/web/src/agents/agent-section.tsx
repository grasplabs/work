import { CalendarIcon, LockIcon, StickyNoteIcon } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { Link, useMatch } from "@tanstack/react-router";

import type { SidebarRow, SidebarSection } from "../frame/sidebar.tsx";
import { AgentFigure } from "./agent-avatar.tsx";
import { wakesOn } from "./agent-facts.tsx";
import { agentTabOf } from "./agent-page.tsx";
import type { AgentTab } from "./agent-page.tsx";

// One agent as a level of the sidebar while its page is open, as the
// reference's (#2503's agents/agent-section.tsx): the agent's figure and
// name, which open its overview, beside Back to the Agents page; then a
// row per other part of its page. The parts are its page's tabs, kept in
// the address (`?tab=`), so a row is a link the page reads. A person's own
// agent has no access or schedule to set, so no row for either. What it
// shows is what the agent's route read: no read of its own.

/** The agent's page, as a level of the sidebar; undefined anywhere else. */
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
  const read = page?.state === "ready" ? page.data : null;
  const agent =
    read?.own.find(({ id }) => id === agentId) ??
    read?.managed?.agents.find(({ id }) => id === agentId);
  // Until the agent is read, and for one that isn't there: the page says so.
  if (read === null || read === undefined || agent === undefined) {
    return undefined;
  }
  const { name } = agent;
  const own = agent.ownerId !== null;
  const tab = agentTabOf(match.search.tab);
  const scheduled = wakesOn(read.managed?.wakes[agent.id] ?? []).length;
  const row = (value: AgentTab, label: string, icon: IconData): SidebarRow => ({
    id: value,
    label,
    icon,
    render: (look) => (
      <Link
        {...look}
        params={{ agent: agent.id }}
        replace
        search={{ tab: value }}
        to="/agents/$agent"
      />
    ),
    current: tab === value,
  });
  return {
    id: `agent/${agent.id}`,
    title: name,
    mark: <AgentFigure face={agent.face} />,
    navLabel: t`${name}'s pages`,
    // Its name opens its overview: no Overview row of its own.
    home: (look) => (
      <Link
        {...look}
        params={{ agent: agent.id }}
        replace
        search={{}}
        to="/agents/$agent"
      />
    ),
    // A tab its own agent hasn't is its overview, as its page shows it.
    homeCurrent: tab === "overview" || (own && tab !== "instructions"),
    back: { label: t`Back`, render: (look) => <Link {...look} to="/agents" /> },
    groups: [
      {
        rows: [
          row("instructions", t`Instructions`, StickyNoteIcon),
          ...(own
            ? []
            : [
                row("access", t`Access`, LockIcon),
                {
                  ...row("schedule", t`Schedule`, CalendarIcon),
                  ...(scheduled === 0 ? {} : { count: scheduled }),
                },
              ]),
        ],
      },
    ],
  };
};
