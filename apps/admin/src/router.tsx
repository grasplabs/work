import { createRouter } from "@tanstack/react-router";

import { RouteFailure } from "./admin/failure.tsx";
import { orgReads } from "./admin/org-reads.ts";
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
    // This router's own reads of clients' cores: one tab's, or one server render's.
    context: { reads: orgReads() },
    // A link's page is read as the pointer rests on it, or it takes focus:
    // a section switch then shows at once.
    defaultPreload: "intent",
    // A route that fails shows so where it would be, never the router's own page.
    defaultErrorComponent: RouteFailure,
  });
