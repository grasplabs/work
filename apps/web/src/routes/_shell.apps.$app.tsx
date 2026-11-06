import { DropdownMenuItem } from "@grasp-os/ui/components/dropdown-menu";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { LayoutGridIcon, Maximize2Icon } from "lucide-react";

import { AppPage } from "../engines/app-page.tsx";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { pageHref, useAppAddress } from "../pages/app-address.ts";
import { PageFrame } from "../pages/page-frame.tsx";

// The live App (engines/app-page.tsx), as its people use it: its current
// version. Its pages run as one single page app in the frame under its
// bar, routed by the App's own router; where it is goes in the address
// (pages/app-address.ts): its `/` here, every other route under
// `pages/` (_shell.apps.$app.pages.$.tsx, which draws nothing of its own,
// so moving between the App's routes keeps this page and its frame). An
// archived App opens nothing, as nobody uses one until it is restored.
// "Open full page" opens the route open now outside the shell
// (apps.$app.full.tsx). Its builders build it in its workspace
// (_shell.apps.$app_.edit.tsx), never here.

const AppPageView = () => {
  const { app: id } = Route.useParams();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const router = useRouter();
  const { t } = useLingui();
  const address = useAppAddress({
    root: `/apps/${id}`,
    sub: `/apps/${id}/pages`,
  });
  if (page.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={[{ label: t`Apps`, to: "/apps" }, { label: t`App` }]}
        icon={LayoutGridIcon}
        notFound={t`App not found`}
        page={page}
      />
    );
  }
  const { app, contents } = page.data;
  const opens = contents.pages && app.status !== "archived";
  return (
    <>
      <SiteHeader
        crumbs={[{ label: t`Apps`, to: "/apps" }, { label: app.name }]}
      />
      <AppPage
        app={app}
        identity={identity}
        // Another App starts afresh: nothing the last one said stays.
        key={app.id}
        fullPage={
          opens ? (
            <DropdownMenuItem
              render={
                // Where the App is, its search and hash as the App wrote
                // them, full page: outside the shell, so a document of
                // its own.
                <a
                  aria-label={t`Open full page`}
                  href={pageHref(
                    { root: `/apps/${id}/full`, sub: `/apps/${id}/full` },
                    address.at ?? "/"
                  )}
                />
              }
            >
              <Maximize2Icon />
              <Trans>Open full page</Trans>
            </DropdownMenuItem>
          ) : null
        }
        opens={opens}
      >
        {opens ? (
          <PageFrame
            app={id}
            at={address.at}
            // The App's bar holds the page's heading, its name.
            embedded
            onMoved={address.handleMoved}
            // Loading the App again reads its current version again too.
            onReload={() => {
              void router.invalidate();
            }}
            ownPath={address.own}
          />
        ) : null}
      </AppPage>
    </>
  );
};

export const Route = createFileRoute("/_shell/apps/$app")({
  pendingComponent: PageLoading,
  component: AppPageView,
  // Moving between the App's own routes (`pages/`) reads nothing again:
  // the frame routes them. Loading the App again (`invalidate`) still does.
  shouldReload: false,
  loader: async ({ context: { core }, params }) =>
    await loadFromCore(core, async (session) => {
      const [app, contents] = await Promise.all([
        session.apps.get(params.app),
        session.apps.contents(params.app),
      ]);
      return { app, contents };
    }),
});
