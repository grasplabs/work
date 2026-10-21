import { buttonVariants } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  createFileRoute,
  Link,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { CogIcon, Maximize2Icon } from "lucide-react";

import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { ScreenFrame } from "../screens/screen-frame.tsx";
import {
  useScreenNavigate,
  useScreenOpening,
} from "../screens/screen-navigate.ts";

// One of an engine's apps (core's screens), in the Grasp frame: the site
// header with the way back to its engine and "Open full page", then the
// app in its sandboxed frame with its own chrome (screens/screen-frame.tsx),
// which says what the engine drew and shows a screen that failed to build,
// or a newer version, as before. Loading it again after a new version that
// no longer has this app opens the engine's first app instead.

const AppPage = () => {
  const { engine, screen } = Route.useParams();
  // What core resolved for this entry; none for an address opened by hand.
  const opening = useScreenOpening(engine, screen);
  const navigate = useScreenNavigate(engine, "/domains/$engine/apps/$screen");
  const page = Route.useLoaderData();
  const router = useRouter();
  const { t } = useLingui();
  if (page.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={[{ label: t`Domains`, to: "/domains" }, { label: t`Domain` }]}
        icon={CogIcon}
        notFound={t`Domain not found`}
        page={page}
      />
    );
  }
  const { app } = page.data;
  return (
    <>
      <SiteHeader
        actions={
          <Link
            className={buttonVariants({ size: "sm", variant: "outline" })}
            params={{ engine, screen }}
            state={(previous) => ({ ...previous, screenOpening: opening })}
            to="/domains/$engine/apps/$screen/full"
          >
            <Maximize2Icon data-icon="inline-start" />
            <Trans>Open full page</Trans>
          </Link>
        }
        crumbs={[
          { label: t`Domains`, to: "/domains" },
          {
            label: app.name,
            to: "/domains/$engine",
            params: { engine },
          },
          { label: screen },
        ]}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <ScreenFrame
          app={engine}
          // A navigation to another input of the same screen starts it
          // afresh, as one to another screen does.
          key={`${engine}/${screen}/${opening === undefined ? "" : JSON.stringify(opening)}`}
          onNavigate={navigate}
          // Loading the app again reads the engine's current version again
          // too: its apps may have changed with it.
          onReload={() => {
            void router.invalidate();
          }}
          screen={screen}
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
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/domains/$engine/apps/$screen")({
  pendingComponent: PageLoading,
  component: AppPage,
  loader: async ({ context: { core }, params }) => {
    const page = await loadFromCore(core, async (session) => {
      const [app, contents] = await Promise.all([
        session.apps.get(params.engine),
        session.apps.contents(params.engine),
      ]);
      return { app, contents };
    });
    const [first] = page.state === "ready" ? page.data.contents.screens : [];
    if (
      page.state === "ready" &&
      first !== undefined &&
      !page.data.contents.screens.includes(params.screen)
    ) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({
        to: "/domains/$engine/apps/$screen",
        params: { engine: params.engine, screen: first },
        replace: true,
      });
    }
    return page;
  },
});
