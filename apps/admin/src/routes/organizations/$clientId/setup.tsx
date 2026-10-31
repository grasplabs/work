import { createFileRoute, notFound } from "@tanstack/react-router";

import { useAnsweredOrganization } from "../../../admin/organization.tsx";
import { OrgSetup, setupTabs } from "../../../admin/setup.tsx";
import type { SetupTab } from "../../../admin/setup.tsx";
import {
  fetchClientAiStatus,
  fetchClientQuotaPolicy,
  fetchClientSetup,
} from "../../../clients/functions.ts";
import {
  fetchClientHosting,
  fetchProvisioningProgress,
} from "../../../hosting/functions.ts";
import { fetchNewClientOptions } from "../../../provision/functions.ts";

const Setup = () => {
  const { clientId } = Route.useParams();
  const { setup, releases, hosting, progress, quotaPolicy, aiStatus } =
    Route.useLoaderData();
  const { tab = "status" } = Route.useSearch();
  // Shown whether or not its core answered: being set up, it has none yet.
  const organization = useAnsweredOrganization();
  return (
    <OrgSetup
      clientId={clientId}
      hosting={hosting}
      aiStatus={aiStatus}
      progress={progress}
      quotaPolicy={quotaPolicy}
      releases={releases}
      setup={setup}
      tab={tab}
      view={organization?.view ?? null}
    />
  );
};

/**
 * An organization's Setup: its own Grasp as this admin runs it, and
 * what someone at Grasp does to it (src/admin/setup.tsx), on the tab its
 * search names, how it stands first. Where the admin's own client page
 * (`/clients/$clientId`) was.
 */
export const Route = createFileRoute("/organizations/$clientId/setup")({
  // Being set up, or not answering, its core has nothing for it: it shows from what the admin recorded.
  staticData: { withoutCore: true },
  // A tab it doesn't have is left out: the router keeps what this doesn't name.
  validateSearch: (search: Record<string, unknown>): { tab?: SetupTab } => {
    const tab = setupTabs.find((each) => each === search.tab);
    return { tab: tab === "status" ? undefined : tab };
  },
  loader: async ({ params }) => {
    // Not awaited: a slow or unreachable core never holds up the Setup. A
    // read that fails (the database included) shows no section, never the
    // route's error page in place of the Setup.
    const quotaPolicy = (async () => {
      try {
        return await fetchClientQuotaPolicy({
          data: { clientId: params.clientId },
        });
      } catch {
        return null;
      }
    })();
    const aiStatus = (async () => {
      try {
        return await fetchClientAiStatus({
          data: { clientId: params.clientId },
        });
      } catch {
        return null;
      }
    })();
    const [setup, { releases }, hosting, progress] = await Promise.all([
      fetchClientSetup({ data: { clientId: params.clientId } }),
      fetchNewClientOptions(),
      fetchClientHosting({ data: { clientId: params.clientId } }),
      fetchProvisioningProgress({ data: { clientId: params.clientId } }),
    ]);
    if (setup === null) {
      throw notFound();
    }
    return { setup, releases, hosting, progress, quotaPolicy, aiStatus };
  },
  component: Setup,
});
