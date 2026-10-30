import { createRouter } from "@tanstack/react-router";

import { RouteFailure } from "./admin/failure.tsx";
import { routeTree } from "./routeTree.gen.ts";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /**
     * An organization's section that shows without what its core
     * answers (its Setup): every other section is shown only once its
     * core answered (src/admin/organization.tsx).
     */
    withoutCore?: boolean;
  }
}

export const getRouter = () =>
  createRouter({
    routeTree,
    scrollRestoration: true,
    // A route that fails shows so where it would be, never the router's own page.
    defaultErrorComponent: RouteFailure,
  });
