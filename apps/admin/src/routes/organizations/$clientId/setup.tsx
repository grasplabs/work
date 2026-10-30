import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { useOrgRead } from "../../../admin/organization.tsx";
import { Checklist, OrgSetup, setupTabs } from "../../../admin/setup.tsx";
import type { SetupTab } from "../../../admin/setup.tsx";
import { organizationOf } from "../../../admin/views.ts";
import {
  fetchClientModelSpend,
  fetchClientQuotaPolicy,
  fetchClientSetup,
} from "../../../clients/functions.ts";
import { fetchClientHosting } from "../../../hosting/functions.ts";
import { hostingPolicyIds } from "../../../hosting/policy.ts";
import { fetchNewClientOptions } from "../../../provision/functions.ts";

/** The checklist, once its core answered; nothing while it doesn't. */
const AnsweredChecklist = ({
  clientId,
  setup,
}: {
  clientId: string;
  setup: Parameters<typeof Checklist>[0]["setup"];
}) => {
  const { admin } = useOrgRead();
  const { view } = organizationOf(admin);
  return view === null ? null : (
    <Checklist
      clientId={clientId}
      contractRead={!view.unknown.contract}
      setup={setup}
      view={view}
    />
  );
};

const Setup = () => {
  const { clientId } = Route.useParams();
  const { setup, releases, hosting, quotaPolicy, modelSpend } =
    Route.useLoaderData();
  const { tab = "status" } = Route.useSearch();
  // Shown whether or not its core answered: being set up, it has none yet.
  // Only its checklist waits for that, in its own place.
  return (
    <OrgSetup
      checklist={
        <Suspense fallback={null}>
          <AnsweredChecklist clientId={clientId} setup={setup} />
        </Suspense>
      }
      clientId={clientId}
      hosting={hosting}
      modelSpend={modelSpend}
      quotaPolicy={quotaPolicy}
      releases={releases}
      setup={setup}
      tab={tab}
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
  loader: async ({ params, preload }) => {
    // Not awaited: a slow or unreachable core never holds up the Setup. A
    // read that fails (the database included) shows no section, never the
    // route's error page in place of the Setup. Neither asks the core on a
    // preload (a link pointed at): that waits until the Setup is opened.
    const quotaPolicy = (async () => {
      if (preload) {
        return null;
      }
      try {
        return await fetchClientQuotaPolicy({
          data: { clientId: params.clientId },
        });
      } catch {
        return null;
      }
    })();
    const modelSpend = (async () => {
      if (preload) {
        return null;
      }
      try {
        return await fetchClientModelSpend({
          data: { clientId: params.clientId },
        });
      } catch {
        return null;
      }
    })();
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
    return { setup, releases, hosting, quotaPolicy, modelSpend };
  },
  // A preload holds what the admin recorded alone: opened, the Setup loads
  // anew and asks its core.
  preloadStaleTime: 0,
  component: Setup,
});
