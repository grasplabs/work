// @vitest-environment happy-dom
import type {
  ChatProject,
  ChatSummary,
  ChatUpdate,
} from "@grasp-os/shared/chat";
import { Toaster } from "@grasp-os/ui/components/toast";
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
import { afterEach, describe, expect, it } from "vite-plus/test";

import { activeChat, setActiveChat } from "./active-chat.ts";
import { ChatMore } from "./chat-more.tsx";

// The open chat's menu in the header, against core's chats as the page
// reaches them over RPC, faked: it copies the chat as the thread shows it,
// renames it from a dialog, moves it into a project and out, and deletes
// it only once the person confirms, leaving it for a new chat.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const question = "How long is leave?";
const answer = "Twenty-five days a year.";

const chatIn = (projectId: string | null): ChatSummary => ({
  id: "chat-1",
  title: "Leave",
  createdAt: "2026-10-20T08:00:00.000Z",
  running: false,
  projectId,
});

const projects: ChatProject[] = [
  {
    id: "project-1",
    name: "HR",
    goal: "",
    createdAt: "2026-10-20T08:00:00.000Z",
    documents: [],
  },
];

/** The chat as core's watch first answers it: a question and its answer. */
const firstUpdate: ChatUpdate = {
  messages: [
    { id: 1, role: "user", text: question, at: "2026-10-20T08:00:00.000Z" },
    {
      id: 2,
      role: "assistant",
      text: answer,
      citations: [],
      code: [],
      end: "done",
      at: "2026-10-20T08:00:05.000Z",
    },
  ],
  partial: null,
  running: false,
  stopped: null,
  held: 0,
  drafts: 0,
};

let root: Root | undefined;
let copied: string[] = [];

/** Lets every pending promise and render settle. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** The menu over the chat `chat`, against a core that records its writes. */
const opened = async (chat: ChatSummary) => {
  const writes: string[] = [];
  const chats = {
    watch: async (
      _chatId: string,
      _after: number | null,
      onUpdate: (update: ChatUpdate) => void
    ) => {
      await Promise.resolve();
      onUpdate(firstUpdate);
      return {
        release: async () => {
          await Promise.resolve();
        },
        [Symbol.dispose]: () => {
          // Nothing held open in the fake.
        },
      };
    },
    rename: async (id: string, name: string) => {
      await Promise.resolve();
      writes.push(`rename ${id} ${name}`);
    },
    moveChat: async (id: string, projectId: string | null) => {
      await Promise.resolve();
      writes.push(`move ${id} ${projectId ?? "out"}`);
    },
    remove: async (id: string) => {
      await Promise.resolve();
      writes.push(`remove ${id}`);
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { chats: typeof chats }) => Promise<T>
    ): Promise<T> => await action({ chats }),
  };
  const rootRoute = createRootRoute({
    component: () => (
      <Toaster>
        <ChatMore chat={chat} projects={projects} sourceNames={new Map()} />
      </Toaster>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/?chat=chat-1"] }),
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
  await settled();
  return { writes, router };
};

/** The element of `role` whose text is `name`. */
const byRole = (role: string, name: string): HTMLElement => {
  const found = [
    ...document.querySelectorAll<HTMLElement>(`[role="${role}"]`),
  ].find((element) => element.textContent?.trim() === name);
  if (found === undefined) {
    throw new Error(`No ${role} named ${name}`);
  }
  return found;
};

const press = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

const openMenu = async (): Promise<void> => {
  const trigger = document.querySelector<HTMLElement>(
    'button[aria-label="More for this chat"]'
  );
  if (trigger === null) {
    throw new Error("No menu for the chat");
  }
  await press(trigger);
};

/** Chooses the item `name` from the menu, through the submenu `under`. */
const choose = async (name: string, under?: string): Promise<void> => {
  await openMenu();
  if (under !== undefined) {
    await press(byRole("menuitem", under));
  }
  await press(byRole("menuitem", name));
};

/** The dialog's button `name`. */
const dialogButton = (name: string): HTMLButtonElement => {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ].find((button) => button.textContent?.trim() === name);
  if (found === undefined) {
    throw new Error(`No button ${name} in the dialog`);
  }
  return found;
};

describe("the open chat's menu", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    copied = [];
    setActiveChat(undefined);
    document.body.replaceChildren();
  });

  it("copies the chat as Markdown, as the thread shows it", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          await Promise.resolve();
          copied.push(text);
        },
      },
    });
    await opened(chatIn(null));
    await choose("Copy as Markdown");
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatch(/^# Leave/u);
    expect(copied[0]).toContain(question);
    expect(copied[0]).toContain(answer);
    expect(byRole("menuitem", "Copied")).toBeDefined();
  });

  it("renames the chat to the name typed in its dialog", async () => {
    const { writes } = await opened(chatIn(null));
    await choose("Rename");
    const field = document.querySelector<HTMLInputElement>(
      'input[aria-label="Chat name"]'
    );
    if (field === null) {
      throw new Error("No name field");
    }
    expect(field.value).toBe("Leave");
    await act(async () => {
      // React tracks the value it set: the element's own setter, as typing
      // goes through, is what it hears change.
      Reflect.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(field, "  Annual leave  ");
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await press(dialogButton("Save"));
    expect(writes).toStrictEqual(["rename chat-1 Annual leave"]);
  });

  it("moves the chat into a project, and out of the one it is in", async () => {
    const outside = await opened(chatIn(null));
    await choose("HR", "Move to project");
    expect(outside.writes).toStrictEqual(["move chat-1 project-1"]);

    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    const inside = await opened(chatIn("project-1"));
    await choose("Take out of the project", "Move to project");
    expect(inside.writes).toStrictEqual(["move chat-1 out"]);
  });

  it("deletes the chat only once the person confirms, and leaves it for a new chat", async () => {
    setActiveChat("chat-1");
    const { writes, router } = await opened(chatIn(null));
    await choose("Delete");
    expect(writes).toStrictEqual([]);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Delete “Leave”?"
    );
    await press(dialogButton("Delete"));
    expect(writes).toStrictEqual(["remove chat-1"]);
    expect(activeChat()).toBeUndefined();
    expect(router.state.location.searchStr).toBe("");
  });
});
