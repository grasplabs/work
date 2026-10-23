import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

import type { CoreConnection } from "../core-connection.ts";
import { PlatformReveal } from "../onboarding/platform-reveal.tsx";

/** What every route gets from the router: the tab's connection to core. */
interface RouterContext {
  core: CoreConnection;
}

// Above every page, the layer that carries the onboarding's brain into the
// platform: it outlives the onboarding's page as the platform opens.
const RootLayout = () => (
  <>
    <Outlet />
    <PlatformReveal />
  </>
);

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});
