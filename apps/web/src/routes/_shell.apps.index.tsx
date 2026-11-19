import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { isMine, sharedWith } from "../apps/app-reach.ts";
import { AppsOverview } from "../apps/apps-overview.tsx";
import { PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { PageSkeletonCards } from "../grasp/blocks/page-skeleton-cards/page-skeleton-cards.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { noneIfRefused } from "../workflows/reads.ts";

// The Apps page (apps/apps-overview.tsx): the Apps the person can open,
// one read (`apps.overview`) that has each App with what its current
// version holds, then whom each App not their own is shared with, read side
// by side, for its tab: shared with them by name, or the company's.

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
      <AppsOverview
        listed={page.data.listed}
        shared={page.data.shared}
        viewer={identity}
      />
    </>
  );
};

/**
 * The Apps before they are read: the bar as it will be, then the header
 * and two rows of waiting cards in the page's dense grid.
 */
const AppsPending = () => {
  const { t } = useLingui();
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Apps` }]} />
      <PageSkeletonCards cards={8} density="dense" descriptionLines={0} />
    </>
  );
};

export const Route = createFileRoute("/_shell/apps/")({
  pendingComponent: AppsPending,
  component: AppsPage,
  loader: async ({ context: { core, identity } }) =>
    await loadFromCore(core, async (session) => {
      const listed = await noneIfRefused(session.apps.overview());
      const others = listed.filter(({ app }) => !isMine(app, identity.userId));
      const reached = await Promise.all(
        others.map(async ({ app }) => {
          const members = await noneIfRefused(
            session.apps.members.list(app.id)
          );
          return sharedWith(members, identity.userId) ? [app.id] : [];
        })
      );
      return { listed, shared: reached.flat() };
    }),
});
