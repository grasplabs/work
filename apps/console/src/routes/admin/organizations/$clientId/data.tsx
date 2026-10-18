import { createFileRoute } from "@tanstack/react-router";

import { OrgData } from "../../../../admin/org-data.tsx";
import { useOrganization } from "../../../../admin/organization.tsx";

const Data = () => <OrgData view={useOrganization().view} />;

/** An organization's Data: what Grasp keeps of its interviews, and what the company sees (src/admin/org-data.tsx). */
export const Route = createFileRoute("/admin/organizations/$clientId/data")({
  component: Data,
});
