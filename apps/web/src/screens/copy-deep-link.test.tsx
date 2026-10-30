// @vitest-environment happy-dom
import type { SurfaceSummary } from "@grasp-os/shared/screens";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { CopyDeepLink } from "./copy-deep-link.tsx";

// "Copy link" on an App's screen against core's screens API as the page
// reaches it over RPC (the boundary from the web app), faked: the App's
// surfaces at its current version. What lands on the clipboard is the
// deep link on the address the page was served from.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const surface = (
  name: string,
  changes: Partial<SurfaceSummary> = {}
): SurfaceSummary => ({
  name,
  kind: "deepLink",
  title: `Title of ${name}`,
  route: name,
  screen: "orders",
  opensEmpty: true,
  ...changes,
});

let root: Root | undefined;

const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** The button on the `orders` screen of the App `sales`, with `surfaces`. */
const shown = async (surfaces: SurfaceSummary[]): Promise<void> => {
  const session = {
    screens: {
      surfaces: async (): Promise<SurfaceSummary[]> => {
        await Promise.resolve();
        return surfaces;
      },
    },
  };
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const rootRoute = createRootRoute({
    component: () => <CopyDeepLink app="sales" screen="orders" />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory(),
    context: { core },
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nProvider>
    );
    await router.load();
  });
  await settled();
};

const press = async (element: Element | undefined) => {
  if (!(element instanceof HTMLElement)) {
    throw new TypeError("Nothing to press");
  }
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name
  );

/** What the page writes to the clipboard while `run` runs. */
const copiedDuring = async (run: () => Promise<void>): Promise<string[]> => {
  const copied: string[] = [];
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockImplementation(async (text: string) => {
      await Promise.resolve();
      copied.push(text);
    });
  try {
    await run();
  } finally {
    write.mockRestore();
  }
  return copied;
};

describe("Copy link on an App's screen", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("copies this screen's deep link on this workspace's own address", async () => {
    await shown([
      surface("new-order"),
      // Another screen's, one that needs input, and one that isn't a link.
      surface("invoice", { screen: "invoices" }),
      surface("order", { opensEmpty: false }),
      surface("orders-sidebar", { kind: "sidebar" }),
    ]);

    const copied = await copiedDuring(async () => {
      await press(button("Copy link"));
    });

    expect(copied).toStrictEqual([
      `${window.location.origin}/links/sales/new-order`,
    ]);
  });

  it("lets the person pick when the screen has more than one deep link", async () => {
    await shown([surface("new-order"), surface("open-orders")]);

    const copied = await copiedDuring(async () => {
      await press(button("Copy link"));
      await press(
        [...document.querySelectorAll('[role="menuitem"]')].find(
          (each) => each.textContent?.trim() === "Title of open-orders"
        )
      );
    });

    expect(copied).toStrictEqual([
      `${window.location.origin}/links/sales/open-orders`,
    ]);
  });

  it("shows nothing when the screen has no deep link that opens with nothing", async () => {
    await shown([surface("order", { opensEmpty: false })]);

    expect(button("Copy link")).toBeUndefined();
  });
});
