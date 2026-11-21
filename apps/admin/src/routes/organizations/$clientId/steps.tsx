import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/app-kit/components/tabs";
import { STAGES } from "@grasp-os/shared/admin/onboarding-admin";
import type { Stage } from "@grasp-os/shared/admin/onboarding-admin";
import { flowInterviews } from "@grasp-os/shared/onboarding-flow";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { OrgFlow } from "../../../admin/flow.tsx";
import { GettingStarted } from "../../../admin/getting-started.tsx";
import { useOrganization } from "../../../admin/organization.tsx";
import { OrgSteps } from "../../../admin/steps.tsx";
import { fetchClientSetup } from "../../../clients/functions.ts";

interface StepsSearch {
  /** The step that is open; the one the organization is at when none is. */
  stage?: Stage;
  /** The Flow, how much onboarding the company goes through, in place of its steps. */
  tab?: "flow";
}

const Steps = () => {
  const { admin, view } = useOrganization();
  const { setup } = Route.useLoaderData();
  const { snapshot } = admin;
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
          <GettingStarted
            agreements={snapshot.agreements}
            clientId={admin.client.id}
            facts={{
              window:
                setup === null
                  ? null
                  : {
                      open: setup.staffWindow.open,
                      pending: setup.configPending,
                    },
              gate: snapshot.gate,
              admins: snapshot.company.admins,
              // A Grasp that says no flow goes through all of it.
              interviews:
                snapshot.flow === undefined ||
                flowInterviews(snapshot.flow.flow),
              roster: snapshot.roster !== null,
              plan: snapshot.plan !== null,
              agreed: snapshot.agreed,
              told: snapshot.told,
            }}
          />
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
  // The staff window is the admin's own record, not the company's Grasp's:
  // read beside the page, and left out of the list when it can't be.
  loader: async ({ params }) => {
    try {
      return {
        setup: await fetchClientSetup({ data: { clientId: params.clientId } }),
      };
    } catch {
      return { setup: null };
    }
  },
  component: Steps,
});
