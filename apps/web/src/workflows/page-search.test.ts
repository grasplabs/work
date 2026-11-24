import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { runsSearchOf, workflowSearchOf } from "./page-search.ts";

// What the workflows pages read of an address: a value that is not one
// they know leaves nothing behind, so a mistyped or old link opens the
// page as it opens without it, never a page that can't draw.

/** What a page at `path` reads of its address, matched by a router as the app's. */
const searchAt = (
  path: string,
  validateSearch: (search: Record<string, unknown>) => object
): Record<string, unknown> => {
  const root = createRootRoute();
  const page = createRoute({
    getParentRoute: () => root,
    path: "/page",
    validateSearch,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const { pathname, search: raw } = router.state.location;
  const search: Record<string, unknown> =
    router.matchRoutes(pathname, raw).at(-1)?.search ?? {};
  // As the page sees it: the keys whose value is set.
  return Object.fromEntries(
    Object.entries(search).filter(([, value]) => value !== undefined)
  );
};

describe("the workflows pages' addresses", () => {
  it("drops a status the runs log doesn't filter by, and keeps one it does", () => {
    expect({
      bad: searchAt("/page?status=nonsense", runsSearchOf),
      good: searchAt("/page?status=failed", runsSearchOf),
    }).toStrictEqual({ bad: {}, good: { status: "failed" } });
  });

  it("drops a view, section or run a workflow's page doesn't have, so it opens on its default view", () => {
    expect({
      bad: searchAt(
        "/page?view=bogus&section=bogus&run=&project=p-1",
        workflowSearchOf
      ),
      good: searchAt(
        "/page?view=settings&section=triggers&chat=c-1",
        workflowSearchOf
      ),
    }).toStrictEqual({
      bad: { project: "p-1" },
      good: { view: "settings", section: "triggers", chat: "c-1" },
    });
  });

  it("opens a run only on Runs: with no view it opens Runs, with another it is dropped", () => {
    expect({
      alone: searchAt("/page?run=r-1", workflowSearchOf),
      onRuns: searchAt("/page?view=runs&run=r-1", workflowSearchOf),
      onFlow: searchAt("/page?view=flow&run=r-1", workflowSearchOf),
      onSettings: searchAt("/page?view=settings&run=r-1", workflowSearchOf),
    }).toStrictEqual({
      alone: { view: "runs", run: "r-1" },
      onRuns: { view: "runs", run: "r-1" },
      onFlow: { view: "flow" },
      onSettings: { view: "settings" },
    });
  });
});
