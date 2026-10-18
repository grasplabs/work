import { createFileRoute } from "@tanstack/react-router";

import { useOrganization } from "../../../../admin/organization.tsx";
import { OrgWorkflows } from "../../../../admin/workflows.tsx";

/** An organization's Workflows: how far each piece of work is known, and what it still lacks. */
const Workflows = () => {
  const { admin, view } = useOrganization();
  return <OrgWorkflows held={admin.snapshot.works !== null} view={view} />;
};

export const Route = createFileRoute(
  "/admin/organizations/$clientId/workflows"
)({
  component: Workflows,
});
