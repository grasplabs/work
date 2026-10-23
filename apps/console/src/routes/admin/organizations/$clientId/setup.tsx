import { createFileRoute, notFound } from "@tanstack/react-router";

import { useAnsweredOrganization } from "../../../../admin/organization.tsx";
import { OrgSetup, setupTabs } from "../../../../admin/setup.tsx";
import type { SetupTab } from "../../../../admin/setup.tsx";
import { fetchClientSetup } from "../../../../clients/functions.ts";
import { fetchClientHosting } from "../../../../hosting/functions.ts";
import { hostingPolicyIds } from "../../../../hosting/policy.ts";
import { fetchNewClientOptions } from "../../../../provision/functions.ts";

const Setup = () => {
  const { clientId } = Route.useParams();
  const { setup, releases, hosting } = Route.useLoaderData();
  const { tab = "status" } = Route.useSearch();
  // Shown whether or not its core answered: being set up, it has none yet.
  const organization = useAnsweredOrganization();
  return (
    <OrgSetup
      clientId={clientId}
      hosting={hosting}
      releases={releases}
      setup={setup}
      tab={tab}
      view={organization?.view ?? null}
    />
  );
};

/**
 * An organization's Setup: its own Grasp as this console runs it, and
 * what someone at Grasp does to it (src/admin/setup.tsx), on the tab its
 * search names, how it stands first. Where the console's own client page
 * (`/clients/$clientId`) was.
 */
export const Route = createFileRoute("/admin/organizations/$clientId/setup")({
  // A tab it doesn't have is left out: the router keeps what this doesn't name.
  validateSearch: (search: Record<string, unknown>): { tab?: SetupTab } => {
    const tab = setupTabs.find((each) => each === search.tab);
    return { tab: tab === "status" ? undefined : tab };
  },
  loader: async ({ params }) => {
    const [setup, { releases }, hosting] = await Promise.all([
      fetchClientSetup({ data: { clientId: params.clientId } }),
      fetchNewClientOptions(),
      fetchClientHosting({
        data: { clientId: params.clientId, policyId: hostingPolicyIds[0] },
      }),
    ]);
    if (setup === null) {
      throw notFound();
    }
    return { setup, releases, hosting };
  },
  component: Setup,
});
