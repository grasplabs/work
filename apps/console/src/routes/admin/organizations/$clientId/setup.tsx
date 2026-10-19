import { createFileRoute, notFound } from "@tanstack/react-router";

import { OrgSetup, setupTabs } from "../../../../admin/setup.tsx";
import type { SetupTab } from "../../../../admin/setup.tsx";
import { fetchClientSetup } from "../../../../clients/functions.ts";

const Setup = () => {
  const setup = Route.useLoaderData();
  const { tab = "status" } = Route.useSearch();
  return <OrgSetup setup={setup} tab={tab} />;
};

/**
 * An organization's Setup: its own Grasp as this console runs it
 * (src/admin/setup.tsx), on the tab its search names, how it stands first.
 */
export const Route = createFileRoute("/admin/organizations/$clientId/setup")({
  // A tab it doesn't have is left out: the router keeps what this doesn't name.
  validateSearch: (search: Record<string, unknown>): { tab?: SetupTab } => {
    const tab = setupTabs.find((each) => each === search.tab);
    return { tab: tab === "status" ? undefined : tab };
  },
  loader: async ({ params }) => {
    const setup = await fetchClientSetup({
      data: { clientId: params.clientId },
    });
    if (setup === null) {
      throw notFound();
    }
    return setup;
  },
  component: Setup,
});
