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

  it("drops a view or section a workflow's page doesn't have, so it opens on its page", () => {
    expect({
      bad: searchAt(
        "/page?view=bogus&section=bogus&project=p-1",
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
});
