import { createFileRoute } from "@tanstack/react-router";

import { OrgFlow } from "../../../admin/flow.tsx";
import { useOrganization } from "../../../admin/organization.tsx";

const Flow = () => {
  const { admin } = useOrganization();
  return <OrgFlow clientId={admin.client.id} flow={admin.snapshot.flow} />;
};

/** An organization's Flow: how much onboarding it goes through, as staff set it. */
export const Route = createFileRoute("/organizations/$clientId/flow")({
  component: Flow,
});
