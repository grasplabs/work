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
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { ChatSwitcherProvider } from "./chat-switcher.tsx";

// The ⌘K window against core's chats as the page reaches them over RPC,
// faked: it opens with the keys on any page, lists the person's chats by
// when they were last used, narrows them by title at once as the person
// types, then to what core found was said, showing where, each chat as
// core lists it now; and the same keys close it again.

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
  make: null,
  archived: false,
});

const board = chat("board", "Board report");
const lease = chat("lease", "Lease of the office");
const travel = chat("travel", "Trip to Lyon");

/**
 * A page in the frame, with nothing of the chats on it, whose core lists
 * `listed` (or, archived, `archived`) and finds `found` for any search.
 */
const shown = async (
  found: (query: string) => Promise<ChatSearchHit[]>,
  listed: ChatSummary[] = [board, lease, travel],
  archived: () => Promise<ChatSummary[]> = async () => await Promise.resolve([])
) => {
  const asked: string[] = [];
  const chats = {
    list: async (which?: { archived?: boolean }) =>
      which?.archived === true
        ? await archived()
        : await Promise.resolve(listed),
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
  return { asked };
};

const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="dialog"]');

/**
 * The chats the window lists, each as its title and any line found under
 * it, under the day they were used; when it was, left out, and the
 * window's own rows ("New chat", "Archived") too.
 */
const rows = (): string[] =>
  [...(dialog()?.querySelectorAll('[role="group"] [role="option"]') ?? [])].map(
    (row) => {
      const read = row.cloneNode(true);
      if (!(read instanceof HTMLElement)) {
        return "";
      }
      for (const time of read.querySelectorAll("time")) {
        time.remove();
      }
      return (read.textContent ?? "").trim();
    }
  );

/**
 * Core's archived chats: at once, as the window counts them when it opens
 * on the rest, then `opened` for the archived list itself.
 */
const archivedThen =
  (archived: ChatSummary[], opened: () => Promise<ChatSummary[]>) =>
  async (): Promise<ChatSummary[]> => {
    archivedThen.counted += 1;
    return archivedThen.counted === 1
      ? await Promise.resolve(archived)
      : await opened();
  };
archivedThen.counted = 0;

/** Chooses the window's row `value` ("archived", "back", a chat's ID), as a click would. */
const choose = async (value: string): Promise<void> => {
  // Once it is there: Archived shows once the archived chats are counted.
  const row = await vi.waitFor(() => {
    const found = dialog()?.querySelector<HTMLElement>(
      `[data-command-value="${value}"]`
    );
    if (found === null || found === undefined) {
      throw new Error(`The window has no row ${value}`);
    }
    return found;
  });
  await act(async () => {
    row.click();
    await Promise.resolve();
  });
};

/** Lets what was started settle: core's answers, and what they set. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

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
      expect(rows().length).toBeGreaterThan(0);
    },
    { timeout: openMs }
  );
};

/** Types `text` into the window's search, as a person would. */
const type = async (text: string): Promise<void> => {
  const input = dialog()?.querySelector<HTMLInputElement>('[role="combobox"]');
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

/** How long the window's code may take to load, built the first time. */
const loadMs = 30_000;

describe("the chats window", () => {
  // The window's code loads the first time it opens: loaded once here, so
  // no test waits on it being built.
  beforeAll(async () => {
    await import("./chat-window.tsx");
  }, loadMs);

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
      "Board report",
      "Lease of the office",
      "Trip to Lyon",
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
    expect(dialog()?.querySelector("mark")?.textContent).toBe("lease");
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

  it("lists the archived chats alone, never the rest's rows meanwhile, and drops a list that comes late", async () => {
    const late = Promise.withResolvers<ChatSummary[]>();
    const old = { ...chat("old", "Old budget"), archived: true };
    archivedThen.counted = 0;
    await shown(
      async () => await Promise.resolve([]),
      [board, lease, travel],
      archivedThen([old], async () => await late.promise)
    );
    await openWindow({ key: "k", metaKey: true });

    await choose("archived");
    const whileArchivedRead = rows();
    await choose("back");
    await vi.waitFor(() => {
      expect(rows()).toHaveLength(3);
    });
    await act(async () => {
      late.resolve([old]);
      await late.promise;
    });
    await settled();

    expect({ whileArchivedRead, back: rows() }).toStrictEqual({
      whileArchivedRead: [],
      back: ["Board report", "Lease of the office", "Trip to Lyon"],
    });
  });

  it("counts the archived chats in the search's name only once their list has come", async () => {
    const later = Promise.withResolvers<ChatSummary[]>();
    const old = { ...chat("old", "Old budget"), archived: true };
    archivedThen.counted = 0;
    await shown(
      async () => await Promise.resolve([]),
      [board, lease, travel],
      archivedThen([old], async () => await later.promise)
    );
    await openWindow({ key: "k", metaKey: true });
    const search = () =>
      dialog()?.querySelector('[role="combobox"]')?.getAttribute("aria-label");

    await choose("archived");
    const whileRead = search();
    await act(async () => {
      later.resolve([old]);
      await later.promise;
    });
    await settled();

    expect({ whileRead, read: search() }).toStrictEqual({
      whileRead: "Archived chats",
      read: "1 archived chat",
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
