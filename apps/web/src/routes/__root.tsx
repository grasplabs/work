import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

import type { CoreConnection } from "../core-connection.ts";
import { loadPartsFor } from "../page-parts.ts";

/** What every route gets from the router: the tab's connection to core. */
interface RouterContext {
  core: CoreConnection;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  // The lean page the tab started on (lean-pages.ts) has what it needs
  // from the start; any other needs the whole stylesheet and catalog
  // first, once.
  beforeLoad: async ({ location }) => {
    await loadPartsFor(location.pathname);
  },
  component: Outlet,
});
