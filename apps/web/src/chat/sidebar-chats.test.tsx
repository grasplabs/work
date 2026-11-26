// @vitest-environment happy-dom
import type { ChatListUpdate, ChatSummary } from "@grasp-os/shared/chat";
import type { Identity } from "@grasp-os/shared/rpc";
import { SidebarProvider, useSidebar } from "@grasp-os/ui/components/sidebar";
import { Toaster } from "@grasp-os/ui/components/toast";
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
import { forgetActiveChats, setActiveChat } from "./active-chat.ts";
import { closeChat, openChat } from "./chat-layout.ts";
import { GlobalChatProvider } from "./global-chat.tsx";
import { useRecentChats } from "./sidebar-chats.tsx";

// The sidebar's recent chats on a phone, where the sidebar is a sheet over
// the page: a chat is a link to its own page, which the frame's sheet
// closes for as it navigates; All chats navigates nowhere, so the sheet
// closes itself first, or it would stay over what opened and keep focus.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const chat: ChatSummary = {
  id: "chat-1",
  title: "Travel costs",
  agentId: "agent-1",
  createdAt: "2026-11-17T09:00:00.000Z",
  lastAt: "2026-11-17T09:00:00.000Z",
  running: false,
  unread: false,
  make: null,
  archived: false,
};

/** The sidebar with the recent chats, and the phone's sheet: whether it is open, and a way to open it. */
const Frame = () => {
  const { openMobile, setOpenMobile } = useSidebar();
  const chats = useRecentChats({ enabled: true });
  return (
    <>
      <output>{openMobile ? "sheet open" : "sheet closed"}</output>
      <button
        onClick={() => {
          setOpenMobile(true);
        }}
        type="button"
      >
        Open the sheet
      </button>
      <FrameSidebar
        aria-label="Sidebar"
        closeLabel="Close"
        foldLabel="Show or hide the sidebar"
        groups={[{ id: "chats", rows: chats.rows, more: chats.more }]}
        mark={null}
        navLabel="Main"
        profile={null}
      />
    </>
  );
};

/**
 * Core's list of the person's chats as a test pushes it (`watchList`): the
 * whole of `chats` as the sidebar subscribes, then whatever `push` sends.
 * Nothing else of the list is there to read: the sidebar only follows it.
 */
const listOf = (chats: ChatSummary[]) => {
  let page: ((update: ChatListUpdate) => void) | undefined;
  return {
    watchList: async (onUpdate: (update: ChatListUpdate) => void) => {
      page = onUpdate;
      onUpdate({ chats, removed: [], full: true, archived: 0 });
      return await Promise.resolve({
        release: async () => {
          await Promise.resolve();
        },
        [Symbol.dispose]: () => {
          page = undefined;
        },
      });
    },
    /** Core pushes that these chats changed, as core answers a call. */
    pushNow: (...changed: ChatSummary[]) => {
      page?.({ chats: changed, removed: [], full: false, archived: 0 });
    },
    /** Core pushes that these chats changed. */
    push: async (...changed: ChatSummary[]) => {
      await act(async () => {
        page?.({ chats: changed, removed: [], full: false, archived: 0 });
        await Promise.resolve();
      });
    },
    /** Core pushes that these chats left the list. */
    drop: async (...removed: string[]) => {
      await act(async () => {
        page?.({ chats: [], removed, full: false, archived: 1 });
        await Promise.resolve();
      });
    },
  };
};

const shown = async () => {
  const session = { chats: { watchList: listOf([chat]).watchList } };
  const core = {
    withSession: async <T,>(
      read: (reached: typeof session) => Promise<T>
    ): Promise<T> => await read(session),
  };
  const rootRoute = createRootRoute({ component: Frame });
  const router: AnyRouter = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/" }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { core },
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

const sheet = (): string => document.querySelector("output")?.textContent ?? "";

const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) => each.textContent.trim() === name
  );
  if (found === undefined) {
    throw new Error(`No button "${name}"`);
  }
  return found;
};

const press = (name: string) => {
  act(() => {
    button(name).click();
  });
};

describe("the sidebar's recent chats on a phone", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("links each chat to its own page, which the frame's sheet closes for", async () => {
    await shown();
    await vi.waitFor(() => {
      expect(
        [...document.querySelectorAll("a")].find(
          (each) => each.textContent.trim() === chat.title
        )
      ).toBeDefined();
    });
    const link = [...document.querySelectorAll("a")].find(
      (each) => each.textContent.trim() === chat.title
    );
    expect(link?.getAttribute("href")).toBe(`/chats/${chat.id}`);
  });

  it("closes the sheet when All chats opens from it", async () => {
    await shown();
    await vi.waitFor(() => {
      expect(button("All chats")).toBeDefined();
    });
    press("Open the sheet");
    expect(sheet()).toBe("sheet open");
    press("All chats");
    expect(sheet()).toBe("sheet closed");
  });
});

// Renaming a chat from its row, as the reference's rows do: a field laid
// over the row where its name stood, which hides it. At every step the row
// shows one text of the name: its own words at rest, the field while it is
// renamed (the link under it is inert, out of reach). A refused rename
// leaves the old name and says so; a late answer never shows over a newer
// one.

/** A chat of the person's, by its ID and title. */
const chatNamed = (
  id: string,
  title: string,
  running = false
): ChatSummary => ({
  ...chat,
  id,
  title,
  running,
});

/** Whether the tab is shown, as the page reads it. */
const setShown = (visible: boolean) => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (visible ? "visible" : "hidden"),
  });
  document.dispatchEvent(new Event("visibilitychange"));
};

/** How many unread dots the sidebar shows. */
const dots = () =>
  document.querySelectorAll("[data-slot=sidebar-row-unread]").length;

/** The sidebar with the recent chats alone, and the toasts. */
const RenameFrame = () => {
  const chats = useRecentChats({ enabled: true });
  return (
    <>
      <FrameSidebar
        aria-label="Sidebar"
        closeLabel="Close"
        foldLabel="Show or hide the sidebar"
        groups={[{ id: "chats", rows: chats.rows, more: chats.more }]}
        mark={null}
        navLabel="Main"
        profile={null}
      />
      <Toaster />
    </>
  );
};

/** Shows the recent chats against a core whose list and rename the test answers. */
const shownWith = async ({
  chats,
  rename = async () => {
    await Promise.resolve();
  },
}: {
  chats: ChatSummary[];
  rename?: (
    chatId: string,
    title: string,
    list: ReturnType<typeof listOf>
  ) => Promise<void>;
}) => {
  const list = listOf(chats);
  const renamed = vi.fn<(chatId: string, title: string) => Promise<void>>(
    async (chatId: string, title: string) => {
      await rename(chatId, title, list);
    }
  );
  const session = {
    chats: { watchList: list.watchList, rename: renamed },
  };
  const core = {
    withSession: async <T,>(
      action: (reached: typeof session) => Promise<T>
    ): Promise<T> => await action(session),
  };
  const rootRoute = createRootRoute({ component: RenameFrame });
  const router: AnyRouter = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/" }),
      createRoute({ getParentRoute: () => rootRoute, path: "/chats/$chatId" }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { core },
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
  return { router, renamed, push: list.push, drop: list.drop };
};

/** The chats' links, in the order the sidebar lists them. */
const order = () =>
  [...document.querySelectorAll<HTMLElement>("a[href^='/chats/']")].map(
    (link) => link.getAttribute("href")
  );

/** The chat's row: the item that holds its link. */
const itemOf = (chatId: string): HTMLElement => {
  const link = document.querySelector<HTMLElement>(
    `a[href="/chats/${chatId}"]`
  );
  const item = link?.closest<HTMLElement>("li");
  if (link === null || item === null || item === undefined) {
    throw new Error(`No row for ${chatId}`);
  }
  return item;
};

const linkIn = (item: HTMLElement): HTMLElement => {
  const link = item.querySelector<HTMLElement>("a");
  if (link === null) {
    throw new Error("No link in the row");
  }
  return link;
};

const fieldIn = (item: HTMLElement): HTMLInputElement | null =>
  item.querySelector<HTMLInputElement>("input[data-row-rename]");

/** What the page's live regions have said: UI SDK's pair, which Damsko's `announce` speaks through. */
const said = (): string[] =>
  [...document.querySelectorAll("[data-ui-sdk-announcer]")].map((region) =>
    region.textContent.trim()
  );

/** What the row says to a screen reader alone, never shown: its rename hint. */
const unseen = new Set(["Double-click or press F2 to rename"]);

/**
 * Every text the row shows: elements with words of their own, and the
 * rename field, less what is out of reach (inside an inert link) or for a
 * screen reader alone.
 */
const shownNames = (item: HTMLElement): string[] => {
  const visible = [...item.querySelectorAll<HTMLElement>("*")]
    .filter((element) => element.closest("[inert]") === null)
    .filter((element) =>
      [...element.childNodes].some(
        (node) =>
          node.nodeType === Node.TEXT_NODE &&
          (node.textContent ?? "").trim() !== ""
      )
    )
    .map((element) => element.textContent.trim())
    .filter((text) => !unseen.has(text));
  const field = fieldIn(item);
  return field === null ? visible : [...visible, `field: ${field.value}`];
};

/** Renames the chat's row from its link by F2, and returns its field. */
const startRename = async (item: HTMLElement): Promise<HTMLInputElement> => {
  act(() => {
    const link = linkIn(item);
    link.focus();
    link.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F2", bubbles: true })
    );
  });
  return await vi.waitFor(() => {
    const field = fieldIn(item);
    if (field === null) {
      throw new Error("No rename field yet");
    }
    return field;
  });
};

const typeInto = (field: HTMLInputElement, value: string) => {
  act(() => {
    field.value = value;
  });
};

const key = (field: HTMLInputElement, name: string) => {
  act(() => {
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true })
    );
  });
};

const leave = (field: HTMLInputElement) => {
  act(() => {
    field.blur();
  });
};

describe("renaming a recent chat from its row", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("shows one text at every step of a rename by Enter, and focus comes back to the row", async () => {
    const { renamed } = await shownWith({
      chats: [chatNamed("chat-1", "Travel costs")],
      // Core keeps it, and pushes the chat renamed.
      rename: async (_id, next, list) => {
        list.pushNow(chatNamed("chat-1", next));
        await Promise.resolve();
      },
    });
    const item = await vi.waitFor(() => itemOf("chat-1"));
    const atRest = shownNames(item);
    const field = await startRename(item);
    const renaming = shownNames(item);
    const inert = linkIn(item).hasAttribute("inert");
    typeInto(field, "  Board report  ");
    key(field, "Enter");
    await vi.waitFor(() => {
      expect(shownNames(itemOf("chat-1"))).toStrictEqual(["Board report"]);
    });
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(linkIn(itemOf("chat-1")));
    });
    // Once core kept it, a screen reader hears the new name.
    await vi.waitFor(() => {
      expect(said()).toContain("Renamed to Board report");
    });
    expect({
      atRest,
      renaming,
      inert,
      calls: renamed.mock.calls,
    }).toStrictEqual({
      atRest: ["Travel costs"],
      renaming: ["field: Travel costs"],
      inert: true,
      calls: [["chat-1", "Board report"]],
    });
  });

  it("keeps the name, as one text, when the field is left with the name unchanged", async () => {
    const { renamed } = await shownWith({
      chats: [chatNamed("chat-1", "Travel costs")],
    });
    const item = await vi.waitFor(() => itemOf("chat-1"));
    const field = await startRename(item);
    leave(field);
    await vi.waitFor(() => {
      expect(fieldIn(item)).toBeNull();
    });
    expect({
      shown: shownNames(item),
      inert: linkIn(item).hasAttribute("inert"),
      calls: renamed.mock.calls.length,
    }).toStrictEqual({ shown: ["Travel costs"], inert: false, calls: 0 });
  });

  it("keeps the name on Escape and on an empty name, and focus comes back after Escape", async () => {
    const { renamed } = await shownWith({
      chats: [chatNamed("chat-1", "Travel costs")],
    });
    const item = await vi.waitFor(() => itemOf("chat-1"));
    const escaped = await startRename(item);
    typeInto(escaped, "Something else");
    key(escaped, "Escape");
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(linkIn(item));
    });
    const afterEscape = shownNames(item);
    const emptied = await startRename(item);
    typeInto(emptied, "   ");
    key(emptied, "Enter");
    await vi.waitFor(() => {
      expect(fieldIn(item)).toBeNull();
    });
    expect({
      afterEscape,
      afterEmpty: shownNames(item),
      calls: renamed.mock.calls.length,
    }).toStrictEqual({
      afterEscape: ["Travel costs"],
      afterEmpty: ["Travel costs"],
      calls: 0,
    });
  });

  it("brings the old name back, and says so, when core refuses the rename", async () => {
    await shownWith({
      chats: [chatNamed("chat-1", "Travel costs")],
      rename: async () => {
        await Promise.reject(new Error("refused"));
      },
    });
    const item = await vi.waitFor(() => itemOf("chat-1"));
    const field = await startRename(item);
    typeInto(field, "Board report");
    key(field, "Enter");
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain(
        "The chat couldn't be renamed. Try again."
      );
    });
    expect({
      shown: shownNames(itemOf("chat-1")),
      said: said().filter((words) => words.startsWith("Renamed")),
    }).toStrictEqual({ shown: ["Travel costs"], said: [] });
  });

  it("shows a rename made elsewhere as core pushes it, the row staying where it is", async () => {
    const { push } = await shownWith({
      chats: [chatNamed("chat-1", "Travel costs")],
    });
    await vi.waitFor(() => itemOf("chat-1"));
    await push(chatNamed("chat-1", "Renamed elsewhere"));
    expect(shownNames(itemOf("chat-1"))).toStrictEqual(["Renamed elsewhere"]);
  });

  it("shows the Working mark while the chat's agent answers, and no more once the answer ends", async () => {
    const { push } = await shownWith({
      chats: [chatNamed("chat-1", "Month-end", true)],
    });
    await vi.waitFor(() => {
      expect(
        document.querySelectorAll("[data-slot=sidebar-row-working]")
      ).toHaveLength(1);
    });
    await push(chatNamed("chat-1", "Month-end", false));
    expect(
      document.querySelectorAll("[data-slot=sidebar-row-working]")
    ).toHaveLength(0);
  });

  it("shows a dot said as Unread once an answer the person hasn't seen ends, never while it works nor on the chat open in front of them", async () => {
    const { router, push } = await shownWith({
      chats: [{ ...chatNamed("chat-1", "Month-end"), running: true }],
    });
    const marks = () => ({
      working: document.querySelectorAll("[data-slot=sidebar-row-working]")
        .length,
      dot: document.querySelectorAll("[data-slot=sidebar-row-unread]").length,
      said: linkIn(itemOf("chat-1")).textContent.includes("Unread"),
    });
    await vi.waitFor(() => {
      expect(marks()).toStrictEqual({ working: 1, dot: 0, said: false });
    });

    // Done in the background, with the tab hidden: the dot at once.
    act(() => {
      setShown(false);
    });
    await push({ ...chatNamed("chat-1", "Month-end"), unread: true });
    act(() => {
      setShown(true);
    });
    expect(marks()).toStrictEqual({ working: 0, dot: 1, said: true });

    // Opened: no dot on the chat in front of them.
    await act(async () => {
      await router.navigate({
        to: "/chats/$chatId",
        params: { chatId: "chat-1" },
      });
    });
    await vi.waitFor(() => {
      expect(marks()).toStrictEqual({ working: 0, dot: 0, said: false });
    });
  });

  it("shows no dot on the chat open beside the page, and shows it again once that chat is closed to its bar", async () => {
    const chats = {
      watchList: listOf([{ ...chatNamed("chat-1", "Month-end"), unread: true }])
        .watchList,
      models: async () => await Promise.resolve(["openai/gpt-5"]),
      efforts: async () => await Promise.resolve({}),
      agents: async () => await Promise.resolve([]),
      names: async () => await Promise.resolve({}),
      summary: async () =>
        await Promise.resolve(chatNamed("chat-1", "Month-end")),
      heldCalls: async () => await Promise.resolve([]),
      worked: async () => await Promise.resolve([]),
      watch: async () => await Promise.withResolvers<never>().promise,
      markRead: async () => await Promise.withResolvers<never>().promise,
    };
    const core = {
      withSession: async <T,>(
        action: (reached: { chats: typeof chats }) => Promise<T>
      ): Promise<T> => await action({ chats }),
    };
    const identity: Identity = {
      userId: "user-1",
      email: "user-1@acme.test",
      name: "user-1",
      role: "builder",
      teams: [],
      staff: false,
      expiresAt: "2026-11-01T09:00:00.000Z",
    };
    const rootRoute = createRootRoute({ component: Outlet });
    const shell = createRoute({
      getParentRoute: () => rootRoute,
      id: "_shell",
      beforeLoad: () => ({ identity }),
      component: () => (
        <GlobalChatProvider>
          <RenameFrame />
        </GlobalChatProvider>
      ),
    });
    const router: AnyRouter = createRouter({
      routeTree: rootRoute.addChildren([
        shell.addChildren([
          createRoute({ getParentRoute: () => shell, path: "/apps" }),
        ]),
      ]),
      history: createMemoryHistory({ initialEntries: ["/apps"] }),
      context: { core },
    });
    setActiveChat("chat-1", "chat");
    openChat("floating");
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
    await vi.waitFor(() => {
      expect(linkIn(itemOf("chat-1"))).toBeDefined();
    });
    const beside = dots();

    act(() => {
      closeChat();
    });
    await vi.waitFor(() => {
      expect(dots()).toBe(1);
    });
    act(() => {
      forgetActiveChats();
    });
    expect(beside).toBe(0);
  });

  it("moves a chat asked in, here or on another device, to the top as core pushes it, and drops one deleted or archived", async () => {
    const { push, drop } = await shownWith({
      chats: [
        { ...chatNamed("chat-2", "Newer"), lastAt: "2026-11-17T10:00:00.000Z" },
        chatNamed("chat-1", "Older"),
      ],
    });
    await vi.waitFor(() => {
      expect(order()).toStrictEqual(["/chats/chat-2", "/chats/chat-1"]);
    });
    await push({
      ...chatNamed("chat-1", "Older", true),
      lastAt: "2026-11-17T11:00:00.000Z",
    });
    const asked = order();
    await drop("chat-2");
    expect({ asked, dropped: order() }).toStrictEqual({
      asked: ["/chats/chat-1", "/chats/chat-2"],
      dropped: ["/chats/chat-1"],
    });
  });
});
