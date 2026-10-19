import { createFileRoute } from "@tanstack/react-router";

import { OrgLog } from "../../../../admin/org-log.tsx";
import { useOrganization } from "../../../../admin/organization.tsx";
import { fetchOrganizationTrail } from "../../../../admin/trail.ts";

const Log = () => (
  <OrgLog trail={Route.useLoaderData()} view={useOrganization().view} />
);

/**
 * An organization's Log (src/admin/org-log.tsx): what happened at the
 * company, as its core answered, and what Grasp did to it in this console,
 * as the console's audit log recorded it (`fetchOrganizationTrail`).
 */
export const Route = createFileRoute("/admin/organizations/$clientId/log")({
  loader: async ({ params }) =>
    await fetchOrganizationTrail({ data: { clientId: params.clientId } }),
  component: Log,
});
