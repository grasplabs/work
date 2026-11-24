import { Tabs, TabsList, TabsTrigger } from "@grasp-os/ui/components/tabs";
import { useLingui } from "@lingui/react/macro";

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
    <TabsList aria-label={t`Agents`} variant="line">
      {agentsTabs.map((each) => (
        <TabsTrigger key={each} value={each}>
          {tabName[each]}
        </TabsTrigger>
      ))}
    </TabsList>
  );
};

/**
 * An admin's tabs before the agents arrive, in their place over the
 * skeleton's cards: on the tab the address names. With none named, none
 * is chosen yet, as the loaded page then opens on My agents only while
 * the person has agents of their own, which isn't known until it loads
 * (`""` is no tab's value).
 */
export const AgentTabsWaiting = ({ tab }: { tab: AgentsTab | undefined }) => (
  <Tabs value={tab ?? ""}>
    <AgentTabList />
  </Tabs>
);
