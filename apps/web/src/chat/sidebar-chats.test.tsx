// @vitest-environment happy-dom
import type { ChatSummary } from "@grasp-os/shared/chat";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { AnyRouter } from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { Sidebar } from "../grasp/sidebar/index.ts";
import { useRecentChats } from "./sidebar-chats.tsx";

// The sidebar's recent chats against core's list as the page reaches it
// over RPC, faked, in Grasp UI's own Sidebar: the most recent few, each
// with when it was last used, read again once a page resolves, each a link
// to its chat's page, marked there; none for someone who has no chats to
// see.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const today = new Date().toISOString();

const chat = (
  id: string,
  title: string,
  lastAt: string = today
): ChatSummary => ({
  id,
  title,
  agentId: "organization",
  createdAt: lastAt,
  lastAt,
  running: false,
  appId: null,
  via: "web",
  make: null,
});

/** Ten chats, as core lists them: the most recently used first. */
const ten = Array.from({ length: 10 }, (_, index) =>
  chat(`chat-${index}`, `Chat number ${index}`)
);

const shown = async ({
  listed,
  enabled = true,
}: {
  listed: () => ChatSummary[];
  enabled?: boolean;
}) => {
  const chats = { list: async () => await Promise.resolve(listed()) };
  const core = {
    withSession: async <T,>(
      action: (session: { chats: typeof chats }) => Promise<T>
    ): Promise<T> => await action({ chats }),
  };
  const Frame = () => {
    const recent = useRecentChats({ enabled });
    return (
      <Sidebar
        groups={[{ id: "chats", label: "Chats", rows: recent }]}
        label="Sidebar"
      />
    );
  };
  const rootRoute = createRootRoute({ component: Frame });
  const router: AnyRouter = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/" }),
      createRoute({ getParentRoute: () => rootRoute, path: "/brain" }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/chats/$chatId",
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/brain"] }),
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
  return { router };
};

/** The chats' rows: links to their pages. */
const recentRows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('nav a[href^="/chats/"]'),
];

/** Each row's name, without when it was used. */
const titles = (): string[] =>
  recentRows().map((row) => row.firstElementChild?.textContent ?? "");

describe("recent chats in the sidebar", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("lists the eight most recently used chats, the most recent first", async () => {
    await shown({ listed: () => ten });
    await vi.waitFor(() => {
      expect(titles()).toStrictEqual(ten.slice(0, 8).map(({ title }) => title));
    });
  });

  it("reads the chats again once a page resolves, so a rename shows", async () => {
    let listed = ten.slice(0, 2);
    const { router } = await shown({ listed: () => listed });
    await vi.waitFor(() => {
      expect(titles()).toStrictEqual(["Chat number 0", "Chat number 1"]);
    });
    listed = [chat("chat-0", "Board report"), ...ten.slice(1, 2)];
    await act(async () => {
      await router.invalidate();
    });
    await vi.waitFor(() => {
      expect(titles()).toStrictEqual(["Board report", "Chat number 1"]);
    });
  });

  it("says when each chat was last used: short at the row's end, whole to a screen reader", async () => {
    await shown({
      listed: () => [
        chat("old", "Lease of the office", "2025-03-04T10:00:00Z"),
      ],
    });
    await vi.waitFor(() => {
      expect(recentRows()).toHaveLength(1);
    });
    const [row] = recentRows();
    const shownEnd = row?.querySelector('[aria-hidden="true"]')?.textContent;
    expect(shownEnd).toMatch(/4/u);
    expect(shownEnd).not.toMatch(/2025/u);
    expect(row?.textContent).toMatch(/2025/u);
  });

  it("says how long ago a chat used today was, not the clock", async () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    await shown({ listed: () => [chat("new", "Board report", twoMinutesAgo)] });
    await vi.waitFor(() => {
      expect(recentRows()).toHaveLength(1);
    });
    const shownEnd = recentRows()[0]?.querySelector(
      '[aria-hidden="true"]'
    )?.textContent;
    expect(shownEnd).toMatch(/^2\s?m/u);
  });

  it("opens a chat's page from its row, and marks it there", async () => {
    const { router } = await shown({ listed: () => ten.slice(0, 3) });
    await vi.waitFor(() => {
      expect(recentRows()).toHaveLength(3);
    });
    await act(async () => {
      recentRows()[1]?.click();
      await router.load();
    });
    expect(router.state.location.pathname).toBe("/chats/chat-1");
    expect(
      recentRows().map((row) => row.getAttribute("aria-current"))
    ).toStrictEqual([null, "page", null]);
  });

  it("lists nothing when it is off, as for someone in onboarding only", async () => {
    const list = vi.fn<() => ChatSummary[]>(() => ten);
    await shown({ listed: list, enabled: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(recentRows()).toHaveLength(0);
    expect(list).not.toHaveBeenCalled();
  });
});
