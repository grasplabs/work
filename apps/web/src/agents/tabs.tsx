import { useLingui } from "@lingui/react/macro";

import { Tabs, TabsList, TabsTrigger } from "../grasp/tabs/index.ts";

// The tabs of the Agents overview and of an agent's page, on their own:
// the addresses that name them and the overview's waiting tabs come with
// the app (routes' validateSearch and pendingComponent), the pages don't.

/** The overview's tabs, by the names its address carries. */
export const agentsTabs = ["mine", "organization"] as const;
export type AgentsTab = (typeof agentsTabs)[number];

/** The tab an address names; none for any other. */
export const agentsTabOf = (value: unknown): AgentsTab | undefined =>
  agentsTabs.find((tab) => tab === value);

/** An agent's tabs, by the names its address carries. */
export const agentTabs = [
  "overview",
  "instructions",
  "access",
  "schedule",
] as const;
export type AgentTab = (typeof agentTabs)[number];

/** The tab an address names; Overview for any other. */
export const agentTabOf = (value: unknown): AgentTab =>
  agentTabs.find((tab) => tab === value) ?? "overview";

/** The tab row, as the loaded page and its skeleton both stand it. */
export const AgentTabList = () => {
  const { t } = useLingui();
  const tabName = { mine: t`My agents`, organization: t`Organization` };
  return (
    <TabsList aria-label={t`Agents`}>
      {agentsTabs.map((each) => (
        <TabsTrigger key={each} value={each}>
          {tabName[each]}
        </TabsTrigger>
      ))}
    </TabsList>
  );
};

/**
 * An admin's tabs before the agents arrive, in their place over the skeleton's cards: on the tab
 * the address names, else Organization, which always holds the company's first agent.
 */
export const AgentTabsWaiting = ({ tab }: { tab: AgentsTab | undefined }) => (
  <Tabs value={tab ?? "organization"}>
    <AgentTabList />
  </Tabs>
);
