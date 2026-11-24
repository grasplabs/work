import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

import type { CoreConnection } from "../core-connection.ts";

/** What every route gets from the router: the tab's connection to core. */
interface RouterContext {
  core: CoreConnection;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
});
