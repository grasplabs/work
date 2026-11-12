import { STAGES } from "@grasp-os/shared/admin/onboarding-admin";
import type { Stage } from "@grasp-os/shared/admin/onboarding-admin";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { OrgFlow } from "../../../admin/flow.tsx";
import { useOrganization } from "../../../admin/organization.tsx";
import { OrgSteps } from "../../../admin/steps.tsx";

interface StepsSearch {
  /** The step that is open; the one the organization is at when none is. */
  stage?: Stage;
  /** The Flow, how much onboarding the company goes through, in place of its steps. */
  tab?: "flow";
}

const Steps = () => {
  const { admin, view } = useOrganization();
  const { stage, tab = "steps" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <Tabs
      onValueChange={(value: string) => {
        void navigate({ search: value === "flow" ? { tab: "flow" } : {} });
      }}
      value={tab}
    >
      <TabsList aria-label="Steps" variant="line">
        <TabsTrigger className="flex-none" value="steps">
          Steps
        </TabsTrigger>
        <TabsTrigger className="flex-none" value="flow">
          Flow
        </TabsTrigger>
      </TabsList>
      <TabsContent value="steps">
        <div className="mt-4 flex flex-col gap-6">
          <OrgSteps
            clientId={admin.client.id}
            flow={admin.snapshot.flow?.flow}
            gate={admin.snapshot.gate}
            paused={admin.snapshot.paused}
            stage={stage ?? view.stage}
            view={view}
          />
        </div>
      </TabsContent>
      <TabsContent value="flow">
        <div className="mt-4 flex flex-col gap-6">
          <OrgFlow clientId={admin.client.id} flow={admin.snapshot.flow} />
        </div>
      </TabsContent>
    </Tabs>
  );
};

/**
 * An organization's Steps: from the first conversation until Grasp opens,
 * the chosen one opened underneath; and its Flow, which of those steps it
 * goes through at all, as a tab beside them.
 */
export const Route = createFileRoute("/organizations/$clientId/steps")({
  // The router keeps what a search had under a key validated away: a
  // step that isn't one is said to be none, not left out.
  validateSearch: (search: Record<string, unknown>): StepsSearch => ({
    stage: STAGES.find((each) => each === search.stage),
    ...(search.tab === "flow" ? { tab: "flow" as const } : {}),
  }),
  component: Steps,
});
