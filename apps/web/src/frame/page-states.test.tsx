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
import { afterEach, describe, expect, it } from "vite-plus/test";

import { InFrame } from "./in-frame.ts";
import {
  ErrorState,
  NotFound,
  NotFoundState,
  PageError,
} from "./page-states.tsx";

// The pages that stand where a page can't, as the router shows them: an
// address no page has says so and leads to Chat, and a page that didn't
// load says why, reads the page again on Try again, and leads to Chat too.
// Only where the state is the whole page in the frame: a section's own
// error leaves the page around it, and outside the frame nobody may be
// signed in to go to Chat.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const reason = "Grasp can't be reached right now. Reference: req-1";

/** The app at `path`, in the frame or not, counting the broken page's reads. */
const opened = async (path: string, inFrame = true) => {
  const reads = { broken: 0 };
  const rootRoute = createRootRoute({ component: Outlet });
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <p>Chat</p>,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/broken",
      loader: () => {
        reads.broken += 1;
      },
      component: () => <PageError reason={reason} />,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/section",
      component: () => (
        <>
          <ErrorState heading="h2" reason={reason} />
          <NotFoundState heading="h2" title="Note not found" />
        </>
      ),
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    defaultNotFoundComponent: () => <NotFound />,
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <SidebarProvider>
          <InFrame value={inFrame}>
            <RouterProvider router={router} />
          </InFrame>
        </SidebarProvider>
      </I18nProvider>
    );
    await router.load();
  });
  return { router, reads };
};

/** Lets every pending promise and render settle. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** The link or button whose text is `name`, if there is one. */
const control = (name: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>("a, button")].find(
    (element) => element.textContent?.trim() === name
  );

/** Clicks the control named `name`, then lets it settle. */
const click = async (name: string): Promise<void> => {
  const found = control(name);
  if (found === undefined) {
    throw new Error(`No control named ${name}`);
  }
  await act(async () => {
    found.click();
    await Promise.resolve();
  });
  await settled();
};

const heading = (): string | undefined =>
  document.querySelector("h1")?.textContent ?? undefined;

describe("where a page can't stand", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  describe("the not-found page", () => {
    it("says the page isn't here and why, and goes to Chat", async () => {
      const { router } = await opened("/no-such-page");
      expect(heading()).toBe("This page is not here");
      expect(document.body.textContent).toContain(
        "The address may be wrong, or the page was moved or removed."
      );

      await click("Go to Chat");
      expect(router.state.location.pathname).toBe("/");
      expect(document.body.textContent).toContain("Chat");
      expect(heading()).toBeUndefined();
    });

    it("offers no way to Chat outside the frame", async () => {
      await opened("/no-such-page", false);
      expect(heading()).toBe("This page is not here");
      expect(control("Go to Chat")).toBeUndefined();
    });
  });

  describe("the error page", () => {
    it("says why with the request ID, and reads the page again on Try again", async () => {
      const { router, reads } = await opened("/broken");
      expect(heading()).toBe("This page didn't load");
      expect(document.body.textContent).toContain(reason);
      expect(reads.broken).toBe(1);

      await click("Try again");
      expect(reads.broken).toBe(2);
      expect(router.state.location.pathname).toBe("/broken");
    });

    it("goes to Chat", async () => {
      const { router } = await opened("/broken");
      await click("Go to Chat");
      expect(router.state.location.pathname).toBe("/");
    });
  });

  describe("a section's own states", () => {
    it("keep Try again but leave the way on to the page around them", async () => {
      await opened("/section");
      expect(control("Try again")).toBeDefined();
      expect(control("Go to Chat")).toBeUndefined();
    });
  });
});
