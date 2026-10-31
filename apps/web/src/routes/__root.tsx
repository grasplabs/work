import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { useReveal } from "../onboarding/reveal-state.ts";

/** What every route gets from the router: the tab's connection to core. */
interface RouterContext {
  core: CoreConnection;
}

// Loaded once the way in begins, which it does only at the end of the
// onboarding: from the brain filling up, so it's there by the time the
// platform is built.
const PlatformReveal = lazy(async () => {
  const { PlatformReveal: layer } =
    await import("../onboarding/platform-reveal.tsx");
  return { default: layer };
});

// Above every page, the layer that carries the onboarding's brain into the
// platform: it outlives the onboarding's page as the platform opens.
const RootLayout = () => {
  const { phase } = useReveal();
  return (
    <>
      <Outlet />
      {phase === "idle" ? null : (
        <Suspense fallback={null}>
          <PlatformReveal />
        </Suspense>
      )}
    </>
  );
};

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});
