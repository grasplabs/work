import { brainOf } from "@grasp-os/shared/admin/admin-health";
import { CardContent } from "@grasp-os/ui/components/card";
import { ChartBarList } from "@grasp-os/ui/components/chart";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { BrainHealth } from "../../../admin/brain-health.tsx";
import { loadBrainRead } from "../../../admin/brain-loads.ts";
import { OrgData } from "../../../admin/org-data.tsx";
import { useOrganization } from "../../../admin/organization.tsx";
import { Panel, PanelNote } from "../../../admin/panel.tsx";
import { knowledgeSourceWords } from "../../../admin/words.ts";
import { fetchBrainReport } from "../../../clients/brain-functions.ts";

const styles = stylex.create({
  // Each tab's parts, under the tabs.
  tab: {
    display: "flex",
    flexDirection: "column",
    gap: space["6"],
    paddingBlockStart: space["4"],
  },
});

/** The section's tabs: the Brain itself, the first, and the data kept of the interviews. */
const brainTabs = ["brain", "data"] as const;
type BrainTab = (typeof brainTabs)[number];

const tabWords: Record<BrainTab, string> = { brain: "Brain", data: "Data" };

/** The tab in the address; the Brain, the first, has none. */
interface BrainSearch {
  tab?: "data";
}

/**
 * The company's brain, as the prototype shows it
 * (grasplabs/prototype `components/admin/org-brain.tsx`): how much of
 * each source is in, the model's figure (`brainOf`), then how its Brain
 * is doing at work. How well each team was heard is under Interviews.
 *
 * Core sends the admin counts only, never the brain itself: what
 * people said and the facts written down stay in the company's own
 * Grasp. So this section always shows the prototype's state for a
 * brain that isn't shared with Grasp's staff. Showing the brain where
 * a company shares it needs that consent recorded and a read of it
 * from core, neither of which exists yet.
 */
const TheBrain = () => {
  const { admin, view } = useOrganization();
  const { brainRead } = Route.useLoaderData();
  const brain = brainOf(view);
  return (
    <>
      <Text color="muted">
        {`${admin.client.name} doesn’t share its brain with Grasp’s staff, so only its counts show here. What people said stays in their own interviews.`}
      </Text>

      <Panel title="What it stands on">
        {brain.sources.length > 0 ? (
          <CardContent>
            <ChartBarList
              aria-label="How much of each source is in"
              config={{ share: { label: "In" } }}
              data={brain.sources.map(({ source, known }) => ({
                source: knowledgeSourceWords[source],
                share: Math.round(known * 100),
              }))}
              nameKey="source"
              sortOrder="none"
              summary={brain.sources
                .map(
                  ({ source, known }) =>
                    `${knowledgeSourceWords[source]}: ${Math.round(known * 100)}%`
                )
                .join(", ")}
              valueFormatter={(share) => `${share}%`}
            />
          </CardContent>
        ) : (
          // The company's own Grasp counts what is known as one number, without its parts.
          <PanelNote>
            The company’s own Grasp counts what is known as one number, so how
            much of each source is in doesn’t show here yet.
          </PanelNote>
        )}
      </Panel>

      <BrainHealth clientId={admin.client.id} read={brainRead} />
    </>
  );
};

/** The Brain and, beside it, the data kept of the interviews (src/admin/org-data.tsx). */
const BrainSection = () => {
  const { view } = useOrganization();
  const { tab = "brain" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <Tabs
      onValueChange={(value) => {
        void navigate({ search: value === "data" ? { tab: "data" } : {} });
      }}
      value={tab}
    >
      <TabsList aria-label="Brain" variant="line">
        {brainTabs.map((each) => (
          <TabsTrigger key={each} value={each}>
            {tabWords[each]}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="brain">
        <div {...stylex.props(styles.tab)}>
          <TheBrain />
        </div>
      </TabsContent>
      <TabsContent value="data">
        <div {...stylex.props(styles.tab)}>
          <OrgData view={view} />
        </div>
      </TabsContent>
    </Tabs>
  );
};

/**
 * An organization's Brain: what its brain stands on, and how its Brain is
 * doing, read from its core as the tab opens and again after an action,
 * each read in the company's audit log; and, on a tab of its own, the
 * data Grasp keeps of its interviews.
 */
export const Route = createFileRoute("/organizations/$clientId/brain")({
  validateSearch: (search: Record<string, unknown>): BrainSearch =>
    search.tab === "data" ? { tab: "data" } : {},
  loaderDeps: ({ search }) => ({ tab: search.tab }),
  // Not awaited, and not asked on a preload (src/admin/brain-loads.ts):
  // each read is in the company's audit log as staff reading its Brain.
  // The Data tab shows nothing of it, so it asks nothing either.
  loader: ({ params, preload, deps }) => ({
    brainRead: loadBrainRead({
      clientId: params.clientId,
      preload: preload || deps.tab === "data",
      read: async (clientId) => await fetchBrainReport({ data: { clientId } }),
    }),
  }),
  // A preload asks its core nothing: opened, the section loads anew.
  preloadStaleTime: 0,
  component: BrainSection,
});
