// @vitest-environment happy-dom

import type { WaitingFeed } from "@grasp-os/shared/waiting";
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

import { InboxView, useWaitingCount } from "./sidebar-inbox.tsx";

// The sidebar's Inbox view, with how many things wait on the person, from
// core's feed of what waits (`session.waiting.list()`, core's
// waiting-rpc.ts): everything that needs them, and of the notifications
// in it only those still unread. What could go wrong: a read notification
// counted again, an unread one left out, a count shown when nothing waits.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** Core's feed: items of `kinds`, `unread` of its notifications unread. */
const feedOf = (kinds: string[], unread: number): WaitingFeed => ({
  readAt: "2026-11-21T09:00:00.000Z",
  // SAFETY: the count reads an item's kind alone.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  items: kinds.map((kind) => ({ kind })) as never,
  unread: [],
  unreadNotifications: unread,
});

/** The Inbox view, as the sidebar counts it. */
const Counted = () => <InboxView waiting={useWaitingCount()} />;

/** The sidebar's Inbox view, as core answers `feed`: its text once read. */
const shown = async (feed: WaitingFeed): Promise<string | undefined> => {
  const session = {
    waiting: { list: async () => await Promise.resolve(feed) },
  };
  // A stand-in for the tab's connection: each read gets the session above.
  const core = {
    withSession: async (read: (each: typeof session) => Promise<unknown>) =>
      await read(session),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: Counted,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory(),
    // SAFETY: the count reads what waits alone, which the stand-in answers.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    context: { core: core as never },
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
  // The count comes on its own read, after the link.
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
  return host.textContent ?? undefined;
};

describe("the sidebar's Inbox view", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("counts what needs the person and the unread notifications, and nothing more", async () => {
    const feed = feedOf(
      [
        "heldWrite",
        "permissionRequest",
        "decision",
        // Notifications: counted by how many are unread, not one by one.
        "openQuestion",
        "stoppedSchedule",
        "appMessage",
      ],
      2
    );
    // The link's own words, then the figure beside it, in the row.
    await expect(shown(feed)).resolves.toBe("All5 things waiting5");
  });

  it("says nothing waits, with no row, while nothing does", async () => {
    await expect(shown(feedOf([], 0))).resolves.toBe("Nothing waits for you.");
  });
});
