import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

import type { CoreConnection } from "../core-connection.ts";
import { isLeanPath, leanPaths } from "../lean-pages.ts";
import { loadWholeApp } from "../page-parts.ts";

/** What every route gets from the router: the tab's connection to core. */
interface RouterContext {
  core: CoreConnection;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  // A lean page (lean-pages.ts) has what it needs from the start; any
  // other needs the whole stylesheet and catalog first, once.
  beforeLoad: async ({ location }) => {
    if (!isLeanPath(location.pathname, leanPaths)) {
      await loadWholeApp();
    }
  },
  component: Outlet,
});
