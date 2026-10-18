import { STAGES } from "@grasp-os/shared/admin/onboarding-admin";
import type { Stage } from "@grasp-os/shared/admin/onboarding-admin";
import { createFileRoute } from "@tanstack/react-router";

import { useOrganization } from "../../../../admin/organization.tsx";
import { OrgSteps } from "../../../../admin/steps.tsx";

interface StepsSearch {
  /** The step that is open; the one the organization is at when none is. */
  stage?: Stage;
}

const Steps = () => {
  const { admin, view } = useOrganization();
  const { stage } = Route.useSearch();
  return (
    <OrgSteps
      clientId={admin.client.id}
      paused={admin.snapshot.paused}
      stage={stage ?? view.stage}
      view={view}
    />
  );
};

/** An organization's Steps: from the first conversation until Grasp opens, the chosen one opened underneath. */
export const Route = createFileRoute("/admin/organizations/$clientId/steps")({
  // The router keeps what a search had under a key validated away: a
  // step that isn't one is said to be none, not left out.
  validateSearch: (search: Record<string, unknown>): StepsSearch => ({
    stage: STAGES.find((each) => each === search.stage),
  }),
  component: Steps,
});
