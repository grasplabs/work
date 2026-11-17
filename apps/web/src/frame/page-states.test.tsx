// @vitest-environment happy-dom
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
const opened = async (path: string, inFrame = true, core?: object) => {
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
    ...(core === undefined ? {} : { context: { core } }),
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <InFrame value={inFrame}>
          <RouterProvider router={router} />
        </InFrame>
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

/** An element's words as a screen reader hears them: what is hidden from it left out. */
const wordsOf = (element: HTMLElement): string => {
  const copy = element.cloneNode(true);
  if (!(copy instanceof HTMLElement)) {
    return "";
  }
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) {
    hidden.remove();
  }
  return copy.textContent?.trim() ?? "";
};

/** The link or button whose words are `name`, if there is one. */
const control = (name: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>("a, button")].find(
    (element) => wordsOf(element) === name
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

/** Every paragraph's words, as shown. */
const lines = (): string[] =>
  [...document.querySelectorAll("p")].map(
    (line) => line.textContent?.trim() ?? ""
  );

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
      // Why, in its sentence; the reference apart, to copy for support.
      const shown = {
        heading: heading(),
        why: lines().includes("Grasp can't be reached right now."),
        reference: document.body.textContent?.includes("req-1"),
        reads: reads.broken,
      };
      await click("Try again");

      expect({
        ...shown,
        readsAfter: reads.broken,
        at: router.state.location.pathname,
      }).toStrictEqual({
        heading: "This page didn't load",
        why: true,
        reference: true,
        reads: 1,
        readsAfter: 2,
        at: "/broken",
      });
    });

    it("says whether Grasp can be reached, as the tab's connection finds it, as it changes", async () => {
      const watchers = new Set<() => void>();
      const core = {
        reach: "unreachable",
        watchReach: (changed: () => void) => {
          watchers.add(changed);
          return () => {
            watchers.delete(changed);
          };
        },
      };
      await opened("/broken", true, core);
      const before = lines();
      act(() => {
        core.reach = "reachable";
        for (const changed of watchers) {
          changed();
        }
      });

      expect({
        before: before.includes("No answer from Grasp yet"),
        after: lines().includes("Grasp can be reached"),
      }).toStrictEqual({ before: true, after: true });
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
