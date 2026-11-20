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

import { ChatSources } from "./sources.tsx";
import type { SourceName } from "./sources.tsx";

// What the chat read, as the chat's foot shows it: the library's pile of
// sources, opened into its list, each source opening where Grasp shows
// it: a collection, Memory too, in Knowledge, a connection on its
// integration's page, an HTTP connection on Integrations.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const names = new Map<string, SourceName>([
  ["handbook", { name: "Handbook", kind: "collection" }],
  ["memory", { name: "Memory", kind: "memory" }],
  [
    "hubspot-1",
    {
      name: "hubspot (sales@acme.test)",
      kind: "connection",
      integration: "composio:hubspot",
      brand: "hubspot",
    },
  ],
  ["http-1", { name: "Weather API", kind: "connection" }],
]);

/** The chat's sources, `sources` read and `restricted` as core says. */
const shown = async (sources: string[], restricted = false) => {
  const rootRoute = createRootRoute({ component: Outlet });
  const chat = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <ChatSources names={names} provenance={{ sources, restricted }} />
    ),
  });
  const away = [
    "/knowledge/$collection",
    "/integrations",
    "/integrations/$integration",
  ].map((path) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: () => null,
    })
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren([chat, ...away]),
    history: createMemoryHistory(),
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

const press = async (element: HTMLElement | null | undefined) => {
  if (element === null || element === undefined) {
    throw new Error("Nothing to press");
  }
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
};

/** Opens the pile, then presses the source titled `title`; where Grasp went. */
const opened = async (
  title: string,
  router: Awaited<ReturnType<typeof shown>>
) => {
  await press(document.querySelector<HTMLElement>("[data-slot=source-pile]"));
  await press(
    [
      ...document.querySelectorAll<HTMLElement>("[data-slot=source-title]"),
    ].find((element) => element.textContent === title)
  );
  return decodeURIComponent(router.state.location.pathname);
};

describe(ChatSources, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("piles what the chat read, and lists each with its kind once opened", async () => {
    await shown(["handbook", "memory", "hubspot-1", "unknown"]);
    const pile =
      document.querySelector("[data-slot=source-pile]")?.textContent ?? "";
    await press(document.querySelector<HTMLElement>("[data-slot=source-pile]"));
    const rows = [
      ...document.querySelectorAll<HTMLElement>("[data-slot=source-row]"),
    ].map((row) => [row.dataset.kind, row.textContent]);

    expect({ pile: pile.includes("4 sources"), rows }).toStrictEqual({
      pile: true,
      rows: [
        ["file", "Handbook1Knowledge"],
        ["memory", "Memory2Knowledge"],
        ["record", "hubspot (sales@acme.test)3Connection"],
        ["record", "unknown4Connection"],
      ],
    });
  });

  it.for<[string, string]>([
    ["Handbook", "/knowledge/handbook"],
    ["Memory", "/knowledge/memory"],
    ["hubspot (sales@acme.test)", "/integrations/composio:hubspot"],
    ["Weather API", "/integrations"],
  ])("opens %s where Grasp shows it: %s", async ([title, path]) => {
    const router = await shown(["handbook", "memory", "hubspot-1", "http-1"]);

    await expect(opened(title, router)).resolves.toBe(path);
  });

  it("says a restricted chat is restricted, read or not, and shows nothing for a chat that read nothing", async () => {
    await shown([], true);
    const restricted = document.body.textContent;
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await shown([]);

    expect({ restricted, nothing: document.body.textContent }).toStrictEqual({
      restricted: "Restricted",
      nothing: "",
    });
  });
});
