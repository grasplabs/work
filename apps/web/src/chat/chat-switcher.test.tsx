// @vitest-environment happy-dom
import type {
  ChatProject,
  ChatSearchHit,
  ChatSummary,
} from "@grasp-os/shared/chat";
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

import { ChatSwitcher } from "./chat-switcher.tsx";

// The ⌘K window against core's chats as the page reaches them over RPC,
// faked: it opens with the keys, lists the person's chats by when they
// were last used, narrows them by title at once as the person types, then
// to what core found was said, showing where; and a project on the left
// shows its chats alone, with the way to its page.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const today = new Date().toISOString();

const chat = (
  id: string,
  title: string,
  projectId: string | null = null
): ChatSummary => ({
  id,
  title,
  createdAt: today,
  lastAt: today,
  running: false,
  projectId,
  appId: null,
});

const board = chat("board", "Board report", "p-1");
const lease = chat("lease", "Lease of the office");
const travel = chat("travel", "Trip to Lyon");

const projects: ChatProject[] = [
  {
    id: "p-1",
    name: "Q4 board",
    goal: "",
    createdAt: today,
    documents: [],
  },
];

/** The window's opener, whose core finds `found` for any search. */
const shown = async (found: (query: string) => Promise<ChatSearchHit[]>) => {
  const asked: string[] = [];
  const chats = {
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
        <ChatSwitcher
          activeId={undefined}
          chats={[board, lease, travel]}
          projects={projects}
        />
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
 * The chats the window lists, each as its title, its project in all
 * chats, and any line found under it; when it was used left out.
 */
const rows = (): string[] =>
  [...(dialog()?.querySelectorAll("[cmdk-item]") ?? [])].map((row) => {
    const read = row.cloneNode(true);
    if (!(read instanceof HTMLElement)) {
      return "";
    }
    for (const time of read.querySelectorAll("time")) {
      time.remove();
    }
    return (read.textContent ?? "").trim();
  });

const press = async (init: KeyboardEventInit): Promise<void> => {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", init));
    await Promise.resolve();
  });
};

/** Types `text` into the window's search, as a person would. */
const type = async (text: string): Promise<void> => {
  const input = dialog()?.querySelector<HTMLInputElement>("[cmdk-input]");
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

    await press({ key: "k", metaKey: true });
    expect(rows()).toStrictEqual([
      "Board reportQ4 board ·",
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
      "Board reportQ4 board · …the lease ends in March",
      "Lease of the office",
    ]);
    expect(dialog()?.querySelector("mark")?.textContent).toBe("lease");
  });

  it("shows one project's chats alone, with the way to its page", async () => {
    await shown(async () => await Promise.resolve([]));
    await press({ key: "k", ctrlKey: true });

    const scope = [...(dialog()?.querySelectorAll("nav button") ?? [])].find(
      (button) => button.textContent?.startsWith("Q4 board")
    );
    await act(async () => {
      scope?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect({
      rows: rows(),
      pressed: scope?.getAttribute("aria-pressed"),
      page: dialog()?.querySelector('a[href="/projects/p-1"]')?.textContent,
    }).toStrictEqual({
      rows: ["Board report"],
      pressed: "true",
      page: "Instructions and files",
    });

    // The same keys close it again.
    await press({ key: "k", ctrlKey: true });
    await vi.waitFor(() => {
      expect(dialog()).toBeNull();
    });
  });
});
