import { createRouter } from "@tanstack/react-router";

import { NotFound, RouteFailure } from "./admin/failure.tsx";
import { openClientId } from "./admin/org-loads.ts";
import { orgReads } from "./admin/org-reads.ts";
import { reportPageError, reportUncaughtErrors } from "./admin/page-errors.ts";
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

export const getRouter = () => {
  // This router's own reads of clients' cores: one tab's.
  const reads = orgReads();
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    context: {
      reads,
      // What the tab shows is the address the router last resolved, never
      // one it is loading: a load that runs while it is an organization's
      // page is that page loading again (src/admin/org-loads.ts).
      shown: (): string | undefined =>
        openClientId(router.state.resolvedLocation?.pathname ?? "/"),
    },
    // A link's page is read as the pointer rests on it, or it takes focus:
    // a section switch then shows at once.
    defaultPreload: "intent",
    // A route that fails shows so where it would be, never the router's own page.
    defaultErrorComponent: RouteFailure,
    // A page there isn't says so in the admin's frame, under its bar.
    defaultNotFoundComponent: NotFound,
    // A route that fails is reported to the Worker's logs too.
    defaultOnCatch: (error) => {
      void reportPageError("render", error);
    },
  });
  // A read asked anew joins only one begun in the load under way.
  router.subscribe("onBeforeLoad", () => {
    reads.loadBegan();
  });
  // Every change staff make reloads the page with `invalidate` (so do Read
  // again and Try again): answers asked before it may be outdated. The
  // router's events don't say why a load runs, so this is where a change
  // is seen. Two limits, as designed:
  // - only changes made in this tab are seen: one made in another tab, by
  //   another staff member or by the company shows when the answer kept
  //   goes stale (`freshMs`), as before;
  // - every organization's answer counts as possibly changed, not only
  //   the one changed: right after a change, coming to another one while
  //   the frame reads every client again waits for that read, up to
  //   `frameWaitMs`, then asks its core alone (a second read core's audit
  //   log records).
  const { invalidate } = router;
  router.invalidate = async (options) => {
    reads.changed();
    await invalidate(options);
  };
  // What the page throws and never catches, reported with the route's
  // pattern (such as `/organizations/$clientId`), never its URL.
  reportUncaughtErrors(() => router.state.matches.at(-1)?.fullPath);
  return router;
};
