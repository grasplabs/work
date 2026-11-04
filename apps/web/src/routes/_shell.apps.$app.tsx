import { DropdownMenuItem } from "@grasp-os/ui/components/dropdown-menu";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { LayoutGridIcon, Maximize2Icon } from "lucide-react";

import { AppPage } from "../engines/app-page.tsx";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { ScreenFrame } from "../screens/screen-frame.tsx";
import {
  useScreenNavigate,
  useScreenOpening,
} from "../screens/screen-navigate.ts";

// The live App (engines/app-page.tsx), as its people use it: its current
// version. Its pages (core's screens) open in the frame under its bar, the
// one in the address's `screen` or else its first; an archived App opens
// none, as nobody uses one until it is restored. "Open full page" opens
// the open page outside the frame (apps.$app.full.tsx). Its builders build
// it in its workspace (_shell.apps.$app_.edit.tsx), never here.

/** The screen to open: the one asked for, if the App has it, else its first. */
const openScreen = (
  screens: readonly string[],
  asked: string | undefined
): string | undefined =>
  asked !== undefined && screens.includes(asked) ? asked : screens[0];

const AppPageView = () => {
  const { app: id } = Route.useParams();
  const { screen: asked } = Route.useSearch();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const router = useRouter();
  const { t } = useLingui();
  const loaded = page.state === "ready" ? page.data : undefined;
  const open =
    loaded === undefined || loaded.app.status === "archived"
      ? undefined
      : openScreen(loaded.contents.screens, asked);
  // What core resolved for this entry; none for an address opened by hand.
  const opening = useScreenOpening(id, open ?? "");
  const navigate = useScreenNavigate(id, "/apps/$app");
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
        contents={contents}
        fullPage={
          open === undefined ? null : (
            <DropdownMenuItem
              render={
                <Link
                  params={{ app: id }}
                  search={{ screen: open }}
                  state={(previous) => ({
                    ...previous,
                    screenOpening: opening,
                  })}
                  to="/apps/$app/full"
                />
              }
            >
              <Maximize2Icon />
              <Trans>Open full page</Trans>
            </DropdownMenuItem>
          )
        }
        open={open}
      >
        {open === undefined ? null : (
          <ScreenFrame
            app={id}
            // The App's bar holds the page's heading, its name.
            embedded
            // A navigation to another input of the same screen starts it
            // afresh, as one to another screen does.
            key={`${id}/${open}/${opening === undefined ? "" : JSON.stringify(opening)}`}
            onNavigate={navigate}
            // Loading the screen again reads the App's current version
            // again too: its screens may have changed with it.
            onReload={() => {
              void router.invalidate();
            }}
            screen={open}
            {...(opening === undefined
              ? {}
              : {
                  route: opening.route,
                  input: opening.input,
                  ...(opening.surface === undefined
                    ? {}
                    : { surface: opening.surface }),
                })}
          />
        )}
      </AppPage>
    </>
  );
};

export const Route = createFileRoute("/_shell/apps/$app")({
  pendingComponent: PageLoading,
  component: AppPageView,
  // The page to open; any other value (an old or hand-typed address)
  // opens the App's first.
  validateSearch: (search: Record<string, unknown>): { screen?: string } =>
    typeof search.screen === "string" ? { screen: search.screen } : {},
  loader: async ({ context: { core }, params }) =>
    await loadFromCore(core, async (session) => {
      const [app, contents] = await Promise.all([
        session.apps.get(params.app),
        session.apps.contents(params.app),
      ]);
      return { app, contents };
    }),
});
