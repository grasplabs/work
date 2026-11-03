import { canBuild } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { AppsOverview } from "../engines/apps-overview.tsx";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { noneIfRefused } from "../workflows/reads.ts";

// The Apps page (engines/apps-overview.tsx): the Apps the person can open,
// one read (`apps.overview`) that has each App with what its current
// version holds.

const AppsPage = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  if (page.state !== "ready") {
    return <PageNotLoaded crumbs={[{ label: t`Apps` }]} page={page} />;
  }
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Apps` }]} />
      <AppsOverview builds={canBuild(identity.role)} listed={page.data} />
    </>
  );
};

export const Route = createFileRoute("/_shell/apps/")({
  pendingComponent: PageLoading,
  component: AppsPage,
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await noneIfRefused(session.apps.overview())
    ),
});
