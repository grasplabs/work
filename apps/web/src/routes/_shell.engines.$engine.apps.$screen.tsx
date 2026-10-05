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

// One of an engine's apps (core's screens), in the Grasp frame: the site
// header with the way back to its engine and "Open full page", then the
// app in its sandboxed frame with its own chrome (screens/screen-frame.tsx),
// which says what the engine drew and shows a screen that failed to build,
// or a newer version, as before. Loading it again after a new version that
// no longer has this app opens the engine's first app instead.

const AppPage = () => {
  const { engine, screen } = Route.useParams();
  const page = Route.useLoaderData();
  const router = useRouter();
  const { t } = useLingui();
  if (page.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={[{ label: t`Engines`, to: "/engines" }, { label: t`Engine` }]}
        icon={CogIcon}
        notFound={t`Engine not found`}
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
            to="/engines/$engine/apps/$screen/full"
          >
            <Maximize2Icon data-icon="inline-start" />
            <Trans>Open full page</Trans>
          </Link>
        }
        crumbs={[
          { label: t`Engines`, to: "/engines" },
          {
            label: app.name,
            to: "/engines/$engine",
            params: { engine },
          },
          { label: screen },
        ]}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <ScreenFrame
          app={engine}
          key={`${engine}/${screen}`}
          // Loading the app again reads the engine's current version again
          // too: its apps may have changed with it.
          onReload={() => {
            void router.invalidate();
          }}
          screen={screen}
        />
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/engines/$engine/apps/$screen")({
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
        to: "/engines/$engine/apps/$screen",
        params: { engine: params.engine, screen: first },
        replace: true,
      });
    }
    return page;
  },
});
