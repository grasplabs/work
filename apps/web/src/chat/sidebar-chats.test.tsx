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
import { activeChat, setActiveChat } from "./active-chat.ts";
import { useRecentChats } from "./sidebar-chats.tsx";

// The sidebar's recent chats against core's list as the page reaches it
// over RPC, faked, in Grasp UI's own Sidebar: the most recent few under
// Chat, read again once a page resolves, each opening its chat; none for
// someone who has no chats to see.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const today = new Date().toISOString();

const chat = (id: string, title: string): ChatSummary => ({
  id,
  title,
  agentId: "organization",
  createdAt: today,
  lastAt: today,
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
  const opened = vi.fn<() => void>();
  const chats = { list: async () => await Promise.resolve(listed()) };
  const core = {
    withSession: async <T,>(
      action: (session: { chats: typeof chats }) => Promise<T>
    ): Promise<T> => await action({ chats }),
  };
  const Frame = () => {
    const recent = useRecentChats({ enabled, onOpened: opened });
    return (
      <Sidebar
        groups={[{ rows: [{ label: "Chat", href: "/", rows: recent.rows }] }]}
        label="Sidebar"
      />
    );
  };
  const rootRoute = createRootRoute({ component: Frame });
  const router: AnyRouter = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/" }),
      createRoute({ getParentRoute: () => rootRoute, path: "/brain" }),
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
  return { opened, router };
};

/** The rows under Chat, by their names. */
const recentRows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>("nav ul ul button"),
];

const titles = (): string[] => recentRows().map((row) => row.textContent);

describe("recent chats in the sidebar", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    setActiveChat(undefined);
  });

  it("lists the eight most recently used chats under Chat, the most recent first", async () => {
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

  it("opens a chat from its row, and closes the phone's menu", async () => {
    const { opened } = await shown({ listed: () => ten.slice(0, 3) });
    await vi.waitFor(() => {
      expect(recentRows()).toHaveLength(3);
    });
    act(() => {
      recentRows()[1]?.click();
    });
    expect(activeChat()).toBe("chat-1");
    expect(opened).toHaveBeenCalledOnce();
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
