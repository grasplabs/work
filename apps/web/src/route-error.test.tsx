// @vitest-environment happy-dom
import { SidebarProvider } from "@grasp-os/ui/components/sidebar";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { RouteError } from "./route-error.tsx";

// A page whose loader fails, as the router shows it: when the page's file
// is gone after a release, Grasp loads anew once for that file, then says
// so; an answer from core never reloads, whatever its words.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const goneFile =
  "Failed to fetch dynamically imported module: https://grasp.test/assets/_shell.brain-1.js";

/** The page at /page, its loader throwing `error`, shown by RouteError. */
const opened = async (error: Error): Promise<void> => {
  const rootRoute = createRootRoute({ component: Outlet });
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/page",
      loader: () => {
        throw error;
      },
      component: () => <p>Page</p>,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/page"] }),
    defaultErrorComponent: RouteError,
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <SidebarProvider>
          <RouterProvider router={router} />
        </SidebarProvider>
      </I18nProvider>
    );
    await router.load();
  });
};

const closed = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
};

describe("a page that failed to load", () => {
  let reloads = 0;

  beforeEach(() => {
    reloads = 0;
    sessionStorage.clear();
    vi.spyOn(window.location, "reload").mockImplementation(() => {
      reloads += 1;
    });
    // Core, which takes the page's error reports.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => await Promise.resolve(new Response(null)))
    );
  });

  afterEach(() => {
    closed();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads Grasp anew once when its file is gone, then says so", async () => {
    await opened(new TypeError(goneFile));
    const first = reloads;
    closed();
    await opened(new TypeError(goneFile));

    expect({
      first,
      again: reloads,
      said: document.body.textContent.includes(
        "Grasp was updated while this page was open."
      ),
    }).toStrictEqual({ first: 1, again: 1, said: true });
  });

  it("never reloads for an answer from core, whatever its words", async () => {
    await opened(Object.assign(new Error(goneFile), { code: "app.not_found" }));

    expect(reloads).toBe(0);
  });
});
