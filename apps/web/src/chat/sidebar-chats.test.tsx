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
// over RPC, faked, in Grasp UI's own Sidebar: the most recent few, by
// title, read again once a page resolves, each with its menu (archive) and
// renamed in place (F2 or a double-click, Enter saves, Escape keeps), each a link
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
  archived: false,
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
  const renamed = vi.fn<(chatId: string, title: string) => Promise<void>>(
    async () => {
      await Promise.resolve();
    }
  );
  const archived = vi.fn<(chatId: string) => Promise<void>>(async () => {
    await Promise.resolve();
  });
  const chats = {
    list: async () => await Promise.resolve(listed()),
    rename: renamed,
    archive: archived,
  };
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
        aria-label="Sidebar"
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
  return { router, renamed, archived };
};

/** The chats' rows: links to their pages. */
const recentRows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('nav a[href^="/chats/"]'),
];

/** Each row's name. */
const titles = (): string[] => recentRows().map((row) => row.textContent);

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

  it("gives each row its menu, named for its chat", async () => {
    await shown({ listed: () => ten.slice(0, 2) });
    await vi.waitFor(() => {
      expect(recentRows()).toHaveLength(2);
    });
    expect(
      [...document.querySelectorAll("nav button[aria-label^='More for']")].map(
        (button) => button.getAttribute("aria-label")
      )
    ).toStrictEqual(["More for Chat number 0", "More for Chat number 1"]);
  });

  it("archives a chat from its menu", async () => {
    const { archived } = await shown({ listed: () => ten.slice(0, 2) });
    await vi.waitFor(() => {
      expect(recentRows()).toHaveLength(2);
    });
    await act(async () => {
      document
        .querySelector<HTMLElement>(
          "nav button[aria-label='More for Chat number 1']"
        )
        ?.click();
      await Promise.resolve();
    });
    const archive = await vi.waitFor(() => {
      const item = [
        ...document.querySelectorAll<HTMLElement>("[role=menuitem]"),
      ].find((each) => each.textContent.includes("Archive"));
      expect(item).toBeDefined();
      return item;
    });
    await act(async () => {
      archive?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(archived).toHaveBeenCalledWith("chat-1");
    });
  });

  it("renames a chat in place: F2 on its row, a new name, Enter", async () => {
    const { renamed } = await shown({ listed: () => ten.slice(0, 2) });
    await vi.waitFor(() => {
      expect(recentRows()).toHaveLength(2);
    });
    const [row] = recentRows();
    act(() => {
      row?.focus();
      row?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "F2", bubbles: true })
      );
    });
    const field = await vi.waitFor(() => {
      const found = document.querySelector<HTMLInputElement>(
        "nav input[aria-label='Rename Chat number 0']"
      );
      expect(found).not.toBeNull();
      return found;
    });
    act(() => {
      if (field !== null) {
        field.value = "Board report";
        field.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
        );
      }
    });
    await vi.waitFor(() => {
      expect(renamed).toHaveBeenCalledWith("chat-0", "Board report");
    });
    // A screen reader hears the new name.
    await vi.waitFor(() => {
      expect(document.querySelector("[data-announce]")?.textContent).toBe(
        "Renamed to Board report"
      );
    });
  });

  it("keeps the name when renaming is left with Escape", async () => {
    const { renamed } = await shown({ listed: () => ten.slice(0, 1) });
    await vi.waitFor(() => {
      expect(recentRows()).toHaveLength(1);
    });
    act(() => {
      recentRows()[0]?.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true })
      );
    });
    const field = await vi.waitFor(() => {
      const found = document.querySelector<HTMLInputElement>("nav input");
      expect(found).not.toBeNull();
      return found;
    });
    act(() => {
      if (field !== null) {
        field.value = "Something else";
        field.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
      }
    });
    expect(renamed).not.toHaveBeenCalled();
    expect(titles()).toStrictEqual(["Chat number 0"]);
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
