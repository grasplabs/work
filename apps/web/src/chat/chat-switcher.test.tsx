// @vitest-environment happy-dom
import type { ChatSearchHit, ChatSummary } from "@grasp-os/shared/chat";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ChatSwitcherProvider } from "./chat-switcher.tsx";

// The ⌘K window against core's chats as the page reaches them over RPC,
// faked: it opens with the keys on any page, "New chat" first, the
// person's chats by the day they were last used, "Archived chats" last;
// narrows them by title at once as the person types, then to what core
// found was said, showing where, each chat as core lists it now; archives
// one from its row; and the same keys close it again.

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
  archived: false,
});

const board = chat("board", "Board report");
const lease = chat("lease", "Lease of the office");
const travel = chat("travel", "Trip to Lyon");

/**
 * A page in the frame, with nothing of the chats on it, whose core lists
 * `listed` and finds `found` for any search.
 */
const shown = async (
  found: (query: string) => Promise<ChatSearchHit[]>,
  listed: ChatSummary[] = [board, lease, travel]
) => {
  const asked: string[] = [];
  const archived: string[] = [];
  const chats = {
    list: async () =>
      await Promise.resolve(listed.filter(({ id }) => !archived.includes(id))),
    archive: async (id: string) => {
      archived.push(id);
      await Promise.resolve();
    },
    search: async (query: string) => {
      asked.push(query);
      return await found(query);
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { chats: typeof chats }) => Promise<T>
    ): Promise<T> => await action({ chats }),
  };
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <ChatSwitcherProvider>
          <p>Any page</p>
        </ChatSwitcherProvider>
      ),
    }),
    history: createMemoryHistory(),
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
  return { asked, archived };
};

const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="dialog"]');

/**
 * The rows the window lists, each as its words and any line under them;
 * when a chat was used, and its More, left out.
 */
const rows = (): string[] =>
  [...(dialog()?.querySelectorAll('[role="option"]') ?? [])].map((row) => {
    const read = row.cloneNode(true);
    if (!(read instanceof HTMLElement)) {
      return "";
    }
    for (const left of read.querySelectorAll("time, button")) {
      left.remove();
    }
    return read.textContent.trim();
  });

/** The chats among the rows: those between "New chat" and "Archived chats". */
const chatRows = (): string[] =>
  rows().filter((row) => row !== "New chat" && row !== "Archived chats");

const press = async (init: KeyboardEventInit): Promise<void> => {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", init));
    await Promise.resolve();
  });
};

/** How long the window may take to open: the first time, its code loads first. */
const openMs = 5000;

/** Opens the window with `keys`, once it has loaded and read the chats. */
const openWindow = async (keys: KeyboardEventInit): Promise<void> => {
  await press(keys);
  await vi.waitFor(
    () => {
      expect(chatRows().length).toBeGreaterThan(0);
    },
    { timeout: openMs }
  );
};

/** Types `text` into the window's search, as a person would. */
const type = async (text: string): Promise<void> => {
  const input = dialog()?.querySelector<HTMLInputElement>("input");
  if (input === undefined || input === null) {
    throw new Error("The window has no search");
  }
  await act(async () => {
    // React tracks the value it set: the element's own setter, as typing
    // goes through, is what it hears change.
    Reflect.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

describe("the chats window", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("opens with ⌘K on the person's chats, and narrows them by title, then by what core found was said", async () => {
    const answer = Promise.withResolvers<ChatSearchHit[]>();
    const { asked } = await shown(async () => await answer.promise);
    expect(dialog()).toBeNull();

    await openWindow({ key: "k", metaKey: true });
    expect(rows()).toStrictEqual([
      "New chat",
      "Board report",
      "Lease of the office",
      "Trip to Lyon",
      "Archived chats",
    ]);

    // By title at once, before core has looked through what was said.
    await type("lease");
    expect(rows()).toStrictEqual(["Lease of the office"]);
    await vi.waitFor(() => {
      expect(asked).toStrictEqual(["lease"]);
    });

    await act(async () => {
      answer.resolve([
        {
          chat: board,
          said: { before: "…the ", found: "lease", after: " ends in March" },
        },
        { chat: lease, said: null },
      ]);
      await answer.promise;
    });
    expect(rows()).toStrictEqual([
      "Board report…the lease ends in March",
      "Lease of the office",
    ]);
  });

  it("says which chat app a chat came through, and nothing for one started in Grasp", async () => {
    await shown(
      async () => await Promise.resolve([]),
      [board, { ...lease, via: "slack" }, { ...travel, via: "teams" }]
    );
    await openWindow({ key: "k", metaKey: true });
    expect(chatRows()).toStrictEqual([
      "Board report",
      "Lease of the officevia Slack",
      "Trip to Lyonvia Microsoft Teams",
    ]);
  });

  it("shows a chat found as core lists it now, renamed since", async () => {
    const renamed = { ...lease, title: "Office lease 2027" };
    await shown(
      async () => await Promise.resolve([{ chat: lease, said: null }]),
      [board, renamed, travel]
    );
    await openWindow({ key: "k", metaKey: true });
    await type("office");
    await vi.waitFor(() => {
      expect(rows()).toStrictEqual(["Office lease 2027"]);
    });
  });

  it("archives a chat from its row's More, which leaves the list", async () => {
    const { archived } = await shown(async () => await Promise.resolve([]));
    await openWindow({ key: "k", metaKey: true });
    const more = dialog()?.querySelector<HTMLElement>(
      '[aria-label="More for Lease of the office"]'
    );
    if (more === undefined || more === null) {
      throw new Error("No More on the lease's row");
    }
    await act(async () => {
      more.click();
      await Promise.resolve();
    });
    const archive = await vi.waitFor(() => {
      const item = [
        ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ].find((each) => each.textContent.trim() === "Archive");
      if (item === undefined) {
        throw new Error("No Archive in the More");
      }
      return item;
    });

    await act(async () => {
      archive.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect({ archived, rows: chatRows() }).toStrictEqual({
        archived: ["lease"],
        rows: ["Board report", "Trip to Lyon"],
      });
    });
  });

  it("closes again with the same keys", async () => {
    await shown(async () => await Promise.resolve([]));
    await openWindow({ key: "k", ctrlKey: true });

    await press({ key: "k", ctrlKey: true });
    await vi.waitFor(() => {
      expect(dialog()).toBeNull();
    });
  });
});
