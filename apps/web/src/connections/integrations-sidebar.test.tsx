// @vitest-environment happy-dom
import type {
  ListedConnection,
  OfferedCatalog,
} from "@grasp-os/shared/connect";
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
import type { AnyRouter } from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { FrameSidebar } from "../frame/sidebar.tsx";
import type { Outside } from "../frame/way-out.tsx";
import { useIntegrationsSection } from "./integrations-sidebar.tsx";

// The sidebar's kinds of app while Integrations is open: each counts as
// many apps as its own page (`/connectors?group=`) lists, the connected
// ones too, so a kind stays while all its apps are connected.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

type Entry = OfferedCatalog["entries"][number];

const entry = (id: string, group: Entry["group"]): Entry => ({
  source: "native",
  id,
  name: id.toUpperCase(),
  categories: [],
  toolCount: 3,
  logo: null,
  description: null,
  group,
  auth: "managed",
  offered: true,
});

const connected = (provider: string): ListedConnection => ({
  id: crypto.randomUUID(),
  source: "native",
  provider,
  name: provider,
  scope: "shared",
  status: "active",
  ownerUserId: null,
  connectedBy: "me",
  connectedByName: "Me",
  accountName: null,
  createdAt: "2026-10-01T00:00:00.000Z",
});

/** Where the person came from: Chat. */
const cameFrom: Outside = { href: "/", pathname: "/", search: {} };

/** The sidebar with Integrations' section, over the page. */
const Frame = () => {
  const section = useIntegrationsSection(cameFrom);
  return (
    <>
      <FrameSidebar
        aria-label="Sidebar"
        closeLabel="Close"
        foldLabel="Show or hide the sidebar"
        groups={[]}
        mark={null}
        navLabel="Main"
        profile={null}
        {...(section === undefined ? {} : { section })}
      />
      <Outlet />
    </>
  );
};

const shown = async (
  entries: readonly Entry[],
  connections: readonly ListedConnection[]
) => {
  const rootRoute = createRootRoute({ component: Frame });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: "_shell" });
  const integrations = createRoute({
    getParentRoute: () => shell,
    path: "connectors",
  });
  const overview = createRoute({
    getParentRoute: () => integrations,
    path: "/",
    validateSearch: (search: Record<string, unknown>) => search,
    loader: () => ({
      catalog: { state: "ready", data: { entries } },
      connections: { state: "ready", data: connections },
    }),
  });
  const router: AnyRouter = createRouter({
    routeTree: rootRoute.addChildren([
      shell.addChildren([integrations.addChildren([overview])]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/connectors"] }),
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

/** Each kind's row: its count as it shows, by the kind it opens. */
const kinds = (): Record<string, string | undefined> => {
  const counts: Record<string, string | undefined> = {};
  for (const link of document.querySelectorAll<HTMLAnchorElement>("nav a")) {
    const group = new URLSearchParams(link.search).get("group");
    if (group !== null) {
      // The icon is hidden too, before it.
      counts[group] = [...link.querySelectorAll("[aria-hidden='true']")].at(
        -1
      )?.textContent;
    }
  }
  return counts;
};

describe("the sidebar's kinds of app", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("counts the apps of a kind nobody connected yet, as its page lists them", async () => {
    await shown(
      [
        entry("gmail", "Email and calendar"),
        entry("outlook", "Email and calendar"),
      ],
      [connected("gmail")]
    );
    await vi.waitFor(() => {
      expect(kinds()).toStrictEqual({ "Email and calendar": "1" });
    });
  });

  it("leaves out a kind whose apps are all connected: they stand under Connected", async () => {
    await shown(
      [entry("gmail", "Email and calendar"), entry("slack", "Chat")],
      [connected("gmail")]
    );
    await vi.waitFor(() => {
      expect(kinds()).toStrictEqual({ Chat: "1" });
    });
  });
});
