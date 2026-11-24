// @vitest-environment happy-dom
import type { ChatSummary } from "@grasp-os/shared/chat";
import { SidebarProvider, useSidebar } from "@grasp-os/ui/components/sidebar";
import { Toaster } from "@grasp-os/ui/components/toast";
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

import { FrameSidebar } from "../frame/sidebar.tsx";
import { tellChatsChanged } from "./chats-changed.ts";
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

const shown = async () => {
  const session = {
    chats: { list: async () => await Promise.resolve([chat]) },
  };
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
  list,
  rename = async () => {
    await Promise.resolve();
  },
}: {
  list: () => Promise<ChatSummary[]>;
  rename?: (chatId: string, title: string) => Promise<void>;
}) => {
  const renamed = vi.fn<typeof rename>(rename);
  const session = { chats: { list, rename: renamed } };
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
  return { router, renamed };
};

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
    let title = "Travel costs";
    const { renamed } = await shownWith({
      list: async () => await Promise.resolve([chatNamed("chat-1", title)]),
      rename: async (_id, next) => {
        title = next;
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
      list: async () =>
        await Promise.resolve([chatNamed("chat-1", "Travel costs")]),
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
      list: async () =>
        await Promise.resolve([chatNamed("chat-1", "Travel costs")]),
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
      list: async () =>
        await Promise.resolve([chatNamed("chat-1", "Travel costs")]),
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
    expect(shownNames(itemOf("chat-1"))).toStrictEqual(["Travel costs"]);
  });

  it("shows a rename made elsewhere while the row is shown, and never a late answer over it", async () => {
    // The first read answers last, with the name as it was.
    let reads = 0;
    const late = Promise.withResolvers<boolean>();
    const { router } = await shownWith({
      list: async () => {
        reads += 1;
        if (reads === 1) {
          await late.promise;
          return [chatNamed("chat-1", "Travel costs")];
        }
        return [chatNamed("chat-1", "Renamed elsewhere")];
      },
    });
    // Renamed from the chat's own page: the page resolves again, and the list is read again.
    await act(async () => {
      await router.invalidate();
    });
    await vi.waitFor(() => {
      expect(shownNames(itemOf("chat-1"))).toStrictEqual(["Renamed elsewhere"]);
    });
    await act(async () => {
      late.resolve(true);
      await Promise.resolve();
    });
    expect(shownNames(itemOf("chat-1"))).toStrictEqual(["Renamed elsewhere"]);
  });

  it("shows the Working mark while the chat's agent answers, and no more once the answer ends", async () => {
    let answering = true;
    await shownWith({
      list: async () =>
        await Promise.resolve([chatNamed("chat-1", "Month-end", answering)]),
    });
    await vi.waitFor(() => {
      expect(
        document.querySelectorAll("[data-slot=sidebar-row-working]")
      ).toHaveLength(1);
    });
    answering = false;
    await act(async () => {
      tellChatsChanged();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(
        document.querySelectorAll("[data-slot=sidebar-row-working]")
      ).toHaveLength(0);
    });
  });
});
