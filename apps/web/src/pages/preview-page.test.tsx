import { act, createElement, useState } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

// @vitest-environment happy-dom
// React Fast Refresh must hook into React before React DOM loads (as the
// preview runtime orders it): the Refresh runtime is imported first, and
// React DOM, and what loads it, only after it has evaluated.
import {
  commit,
  discard,
  refresh,
  register,
} from "../../../../packages/runtime/src/preview-refresh.ts";
import { previewReceiver } from "../../../../packages/runtime/src/preview-updates.ts";

// Loaded while the file loads, which no timeout holds, rather than in
// the test, whose 5 s should time what it does: their first load is
// most of the test's time, and on a runner busy with other files (CI's
// first shard, beside the package-definition scripts' installs and the
// browser tests) it alone outlasted the test's timeout and its retry's.
const { createRoot } = await import("react-dom/client");
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} = await import("@tanstack/react-router");
const { routeBy } = await import("@grasp-os/runtime/page");

// The App's preview taking an update of its pages, with React, React Fast
// Refresh and TanStack Router themselves: the route tree's module
// evaluated (its components registered by file and name, as the
// compiler's instrumentation does), routed by (page-runtime.ts
// `routeBy`) and swapped in by Refresh. The way it can fail: an update
// that renames a page's component registers a family nothing renders, so
// Refresh alone swaps nothing, and the old page stays while the update
// counts as applied. A component of the same name must keep its state,
// and the router the route it shows.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** How many times a `Desk` was mounted, which its state remembers. */
let mounts = 0;

/** A route tree whose `/` is a desk saying `word`, its state the mount it was made in. */
const desk = (name: string, word: string) => {
  const Page = () => {
    const [mount, setMount] = useState(() => {
      mounts += 1;
      return mounts;
    });
    // A click keeps it: state that is the page's own, as a form's is.
    return createElement(
      "p",
      {
        onClick: () => {
          setMount(mount);
        },
      },
      `${word} (mount ${String(mount)})`
    );
  };
  // As the compiler's instrumentation registers it: its file and name.
  register(Page, `src/routes/index.tsx ${name}`);
  const rootRoute = createRootRoute();
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: Page,
  });
  return { routeTree: rootRoute.addChildren([index]) };
};

/**
 * The route tree's modules by their code, each evaluated anew as a
 * browser evaluates a new module address: new components, registered
 * again.
 */
const modules: Record<string, () => Promise<{ routeTree: unknown }>> = {
  first: async () => await Promise.resolve(desk("Desk", "First")),
  edited: async () => await Promise.resolve(desk("Desk", "Edited")),
  renamed: async () => await Promise.resolve(desk("RenamedDesk", "Renamed")),
};

/** The address of the module of `code`, as core would serve it. */
const addressOf = (code: string): string =>
  String(Object.keys(modules).indexOf(code)).repeat(64);

/** Each module's code, by its address. */
const addressed: Record<string, string> = Object.fromEntries(
  Object.keys(modules).map((code) => [addressOf(code), code])
);

let root: Root | undefined;

describe("a preview's pages as their updates come", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
  });

  it("shows a page renamed in an update, and keeps the state of one only edited", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    // The pages as the frame first loaded them.
    const first = await modules.first?.();
    commit();
    const router = createRouter({
      // SAFETY: the tree `desk` made.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      routeTree: first?.routeTree as Parameters<
        typeof createRouter
      >[0]["routeTree"],
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    root = createRoot(container);
    act(() => {
      root?.render(createElement(RouterProvider, { router }));
    });
    const receive = previewReceiver({
      evaluate: async ({ entry }) => await modules[addressed[entry] ?? ""]?.(),
      commit,
      discard,
      refresh,
      route: (module) => routeBy(router, module),
      renderFailures: () => 0,
      settle: async () => {
        await router.load();
      },
      css: () => "",
      setCss: () => {},
      report: () => {},
    });
    const shown = [container.textContent ?? ""];
    for (const code of ["edited", "renamed"]) {
      // oxlint-disable-next-line no-await-in-loop -- one update after another
      await act(async () => {
        await receive({ entry: addressOf(code), visit: 0, css: "" });
      });
      shown.push(container.textContent ?? "");
    }
    expect(shown).toStrictEqual([
      // As it opened, then edited: its state, its first mount.
      "First (mount 1)",
      "Edited (mount 1)",
      // Renamed: another component, mounted afresh, but shown.
      "Renamed (mount 2)",
    ]);
  });
});
