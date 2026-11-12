import { brainOf } from "@grasp-os/shared/admin/admin-health";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { BrainHealth } from "../../../admin/brain-health.tsx";
import { loadBrainRead } from "../../../admin/brain-loads.ts";
import { OrgData } from "../../../admin/org-data.tsx";
import { useOrganization } from "../../../admin/organization.tsx";
import { BarList } from "../../../admin/parts.tsx";
import { Section } from "../../../admin/section.tsx";
import { knowledgeSourceWords } from "../../../admin/words.ts";
import { fetchBrainReport } from "../../../clients/brain-functions.ts";

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
      <p className="text-muted-foreground">
        {`${admin.client.name} doesn’t share its brain with Grasp’s staff, so only its counts show here. What people said stays in their own interviews.`}
      </p>

      <Section title="What it stands on">
        <div className="border-t px-5 py-4">
          {brain.sources.length > 0 ? (
            <BarList
              label="How much of each source is in"
              rows={brain.sources.map(({ source, known }) => {
                const share = Math.round(known * 100);
                return {
                  id: source,
                  label: knowledgeSourceWords[source],
                  value: share,
                  shown: `${share}%`,
                };
              })}
            />
          ) : (
            // The company's own Grasp counts what is known as one number, without its parts.
            <p className="text-muted-foreground">
              The company’s own Grasp counts what is known as one number, so how
              much of each source is in doesn’t show here yet.
            </p>
          )}
        </div>
      </Section>

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
      onValueChange={(value: string) => {
        void navigate({ search: value === "data" ? { tab: "data" } : {} });
      }}
      value={tab}
    >
      <TabsList aria-label="Brain" variant="line">
        {brainTabs.map((each) => (
          <TabsTrigger className="flex-none" key={each} value={each}>
            {tabWords[each]}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="brain">
        <div className="mt-4 flex flex-col gap-6">
          <TheBrain />
        </div>
      </TabsContent>
      <TabsContent value="data">
        <div className="mt-4 flex flex-col gap-6">
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
