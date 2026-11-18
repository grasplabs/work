// @vitest-environment happy-dom
import type {
  ListedConnection,
  OfferedCatalog,
} from "@grasp-os/shared/connect";
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

import { integrationsOf, sectionsOf } from "./integrations.ts";
import type { Integration } from "./integrations.ts";
import { AddApps, ConnectedList, NeedsYou } from "./overview-lists.tsx";

// The Integrations overview as people meet it: what needs someone to sign
// in again, with its fix; what is connected, each opening the app beside
// the list; and the apps to add, each with what this person can do.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Entry = OfferedCatalog["entries"][number];

const entry = (id: string, name: string, offered = true): Entry => ({
  source: "native",
  id,
  name,
  categories: [],
  toolCount: 3,
  logo: null,
  description: `${name}, in a sentence.`,
  group: "Chat",
  auth: "managed",
  offered,
});

const connection = (
  provider: string,
  change: Partial<ListedConnection> = {}
): ListedConnection => ({
  id: `c-${provider}`,
  source: "native",
  provider,
  scope: "shared",
  status: "active",
  ownerUserId: null,
  connectedBy: "u1",
  connectedByName: "Sanne",
  accountName: null,
  createdAt: "2026-10-01T08:00:00.000Z",
  ...change,
});

const integrations = integrationsOf(
  [
    entry("microsoft", "Microsoft 365"),
    entry("google", "Google Workspace"),
    entry("acme-crm", "Acme CRM"),
    entry("chatter", "Chatter", false),
  ],
  [
    connection("microsoft", { scope: "personal", ownerUserId: "u1" }),
    connection("google", { status: "needs_reauth" }),
  ]
);

let root: Root | undefined;

/** The catalogue at `/integrations`, and the router, to read where a press went. */
const opened = async (
  canConnect: (integration: Integration) => boolean = () => true
) => {
  const sections = sectionsOf(integrations, { show: "all" }, undefined, []);
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations",
    component: () => (
      <>
        <NeedsYou lapsed={sections.lapsed} />
        <ConnectedList
          connected={[...sections.connected, ...sections.unused]}
        />
        <AddApps
          canConnect={canConnect}
          others={sections.others}
          search={null}
        />
      </>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/integrations"] }),
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
  return { host, router };
};

const listNamed = (host: HTMLElement, name: string): HTMLElement => {
  const list = host.querySelector<HTMLElement>(`ul[aria-label="${name}"]`);
  if (list === null) {
    throw new Error(`No list named ${name}`);
  }
  return list;
};

describe("the Integrations catalogue", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("puts the app to sign in to again under Needs you, with its fix, and the rest under Connected", async () => {
    const { host } = await opened();
    const fixes = [...listNamed(host, "Needs you").querySelectorAll("a")].map(
      (fix) => fix.getAttribute("aria-label")
    );
    expect(fixes).toStrictEqual(["Sign in to Google Workspace again"]);
    const connected = [
      ...listNamed(host, "Connected").querySelectorAll("li"),
    ].map((row) => row.textContent);
    expect(connected).toStrictEqual(["Microsoft 365Only you"]);
  });

  it("opens an app beside the list from its fix and from its row", async () => {
    const { host, router } = await opened();
    const opens = async (list: string): Promise<unknown> => {
      await act(async () => {
        listNamed(host, list).querySelector("a")?.click();
        await Promise.resolve();
      });
      return new URLSearchParams(router.state.location.searchStr).get("app");
    };
    await expect(opens("Needs you")).resolves.toBe("native:google");
    await expect(opens("Connected")).resolves.toBe("native:microsoft");
  });

  it("offers Connect where the person may, Open where they may only look, and says what isn't offered", async () => {
    const { host } = await opened(
      (integration) => integration.id !== "acme-crm"
    );
    const apps = [...listNamed(host, "Add an app").querySelectorAll("li")].map(
      (row) => ({
        action: row.querySelector("a")?.getAttribute("aria-label") ?? null,
        offered: !(row.textContent ?? "").includes("Not offered"),
      })
    );
    expect(apps).toStrictEqual([
      { action: "Open Acme CRM", offered: true },
      { action: null, offered: false },
    ]);
  });
});
