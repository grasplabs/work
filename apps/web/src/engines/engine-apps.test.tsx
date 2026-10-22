// @vitest-environment happy-dom
import type { AppContents } from "@grasp-os/shared/apps";
import type { SurfaceSummary } from "@grasp-os/shared/screens";
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

import { EngineApps } from "./engine-apps.tsx";

// A domain's Apps tab as core's App contents and surfaces describe it:
// each app titled and described, and New app opening the start page for
// someone who builds.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const contents: AppContents = {
  version: 3,
  screens: ["invoices", "suppliers"],
  workflows: ["chase"],
};

/** A surface of `screen`, titled `title`. */
const surfaceOf = (screen: string, title: string): SurfaceSummary => ({
  name: screen,
  kind: "sidebar",
  title,
  route: screen,
  screen,
  opensEmpty: true,
});

let root: Root | undefined;

/** The tab at /domains/finance, with what each address shows. */
const shown = async (props: {
  contents: AppContents;
  builds: boolean;
  surfaces?: SurfaceSummary[];
}) => {
  const rootRoute = createRootRoute({ component: Outlet });
  const tab = createRoute({
    getParentRoute: () => rootRoute,
    path: "/domains/finance",
    component: () => (
      <EngineApps
        builds={props.builds}
        contents={props.contents}
        description="Paying suppliers on time"
        engine="finance"
        surfaces={props.surfaces ?? []}
      />
    ),
  });
  const newApp = createRoute({
    getParentRoute: () => rootRoute,
    path: "/apps/new",
    component: () => <h1>New app page</h1>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([tab, newApp]),
    history: createMemoryHistory({ initialEntries: ["/domains/finance"] }),
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
  return router;
};

/** Each card: its link's text and where it goes, and what it says. */
const cards = () =>
  [...document.querySelectorAll('ul[aria-label="Apps"] > li')].map((card) => ({
    link: card.querySelector("a")?.textContent,
    to: card.querySelector("a")?.getAttribute("href"),
    says: card.querySelector("p")?.textContent,
  }));

const link = (text: string): HTMLAnchorElement => {
  const found = [...document.querySelectorAll("a")].find(
    (each) => each.textContent === text
  );
  if (found === undefined) {
    throw new Error(`No link ${text}`);
  }
  return found;
};

describe("a domain's apps", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("shows each app's title and what the domain is for, and New app last for a builder", async () => {
    await shown({
      contents,
      builds: true,
      surfaces: [surfaceOf("invoices", "Open invoices")],
    });

    expect(cards()).toStrictEqual([
      {
        link: "Open invoices",
        to: "/domains/finance/apps/invoices",
        says: "Paying suppliers on time",
      },
      {
        link: "suppliers",
        to: "/domains/finance/apps/suppliers",
        says: "Paying suppliers on time",
      },
      { link: "New app", to: "/apps/new", says: undefined },
    ]);
  });

  it("opens the start page from New app", async () => {
    const router = await shown({ contents, builds: true });

    await act(async () => {
      link("New app").click();
      await router.load();
    });

    expect({
      at: router.state.location.pathname,
      heading: document.querySelector("h1")?.textContent,
    }).toStrictEqual({ at: "/apps/new", heading: "New app page" });
  });

  it("offers New app with no apps yet, and never to someone who doesn't build", async () => {
    await shown({
      contents: { version: 1, screens: [], workflows: [] },
      builds: true,
    });
    const empty = link("New app").getAttribute("href");
    act(() => {
      root?.unmount();
    });
    document.body.innerHTML = "";
    await shown({ contents, builds: false });

    expect({
      empty,
      memberSees: cards().map((card) => card.link),
    }).toStrictEqual({
      empty: "/apps/new",
      memberSees: ["invoices", "suppliers"],
    });
  });
});
