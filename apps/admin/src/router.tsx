import { createRouter, rootRouteId } from "@tanstack/react-router";

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
  // Every change staff make that a core can answer differently after
  // (a command, a link, a client added, retried or discarded) reloads with
  // `invalidate`, the frame included, so its list and counts follow: from
  // then on, answers asked before it may be outdated (src/admin/org-loads.ts).
  // The counts follow because the server functions that change what a
  // summary counts (a command, the kickoff) forget that client's summary
  // kept in the Worker's cache (`forgetSummary`, src/clients/summary.ts),
  // so the frame's read after them asks its core; billing is never kept.
  // A reload that leaves the frame alone changes nothing a core answers:
  // Read again and Try again on an organization's section, and a Setup
  // reading itself again (its polls, and its own settings, which the
  // admin records and a deploy applies later). Two retries reload the
  // frame and count, though nothing changed: Try again on a route that
  // failed, and on organizations that couldn't be read. Counting them
  // costs at most a read of a core again, after a failure; a way to
  // reload without counting could be used to skip a real change. The
  // router's events don't say
  // why a load runs, so this is where a change is seen. Two limits, as
  // designed:
  // - only changes made in this tab are seen: one made in another tab, by
  //   another staff member, by the company or by a deploy finishing shows
  //   once the answer kept goes stale (`freshMs`), and in the frame's
  //   counts once the summary kept goes (a minute);
  // - every organization's answer counts as possibly changed, not only
  //   the one changed: right after a change, coming to another one asks
  //   its core again, unless a read asked after the change is under way.
  const { invalidate } = router;
  router.invalidate = async (options) => {
    const frame = router.state.matches.find(
      (match) => match.routeId === rootRouteId
    );
    const filter = options?.filter;
    if (filter === undefined || (frame !== undefined && filter(frame))) {
      reads.changed();
    }
    await invalidate(options);
  };
  // What the page throws and never catches, reported with the route's
  // pattern (such as `/organizations/$clientId`), never its URL.
  reportUncaughtErrors(() => router.state.matches.at(-1)?.fullPath);
  return router;
};
