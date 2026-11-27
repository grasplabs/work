// @vitest-environment happy-dom

import type { ChatSummary, ChatUpdate } from "@grasp-os/shared/chat";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
  useSearch,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { PanelTitle } from "../frame/panels/head.tsx";
import { activeChat, setActiveChat } from "./active-chat.ts";
import { ChatMoreMenu, useRenameChat } from "./chat-more.tsx";

// The open chat's name at the head of its panel and its menu, against
// core's chats as the page reaches them over RPC, faked: the menu copies
// the chat as the thread shows it and deletes it only once the person
// confirms, leaving it for a new chat; the name renames it where it stands.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const question = "How long is leave?";
const answer = "Twenty-five days a year.";

const leave: ChatSummary = {
  id: "chat-1",
  title: "Leave",
  agentId: "organization",
  createdAt: "2026-10-20T08:00:00.000Z",
  lastAt: "2026-10-20T08:00:00.000Z",
  running: false,
  unread: false,
  make: null,
  archived: false,
};

/** The chat as core's watch first answers it: a question and its answer. */
const firstUpdate: ChatUpdate = {
  messages: [
    { id: 1, role: "user", text: question, at: "2026-10-20T08:00:00.000Z" },
    {
      id: 2,
      role: "assistant",
      text: answer,
      code: [],
      tools: [],
      end: "done",
      at: "2026-10-20T08:00:05.000Z",
    },
  ],
  partial: null,
  running: false,
  stopped: null,
  held: 0,
  worked: 0,
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

/** The chat's name, renamed where it stands, as the chat panel's head draws it. */
const Title = ({ of }: { of: ChatSummary }) => {
  const rename = useRenameChat(of.id);
  return <PanelTitle onRename={rename}>{of.title}</PanelTitle>;
};

/**
 * The menu over the chat the address names (`?chat=`), `chat` first and
 * `others` to go to, against a core that records its writes; with `slow`,
 * core answers the chat's watch only once `answer` is called.
 */
const opened = async (
  chat: ChatSummary,
  { others = [], slow = false }: { others?: ChatSummary[]; slow?: boolean } = {}
) => {
  const writes: string[] = [];
  const answered = Promise.withResolvers<boolean>();
  if (!slow) {
    answered.resolve(true);
  }
  const chats = {
    watch: async (
      _chatId: string,
      _after: number | null,
      onUpdate: (update: ChatUpdate) => void
    ) => {
      await answered.promise;
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
  const all = [chat, ...others];
  const Shown = () => {
    const { chat: open } = useSearch({ strict: false });
    const shown = all.find(({ id }) => id === open) ?? chat;
    // Its own for each chat, as the chat's head keys it.
    return (
      <>
        <Title key={`title-${shown.id}`} of={shown} />
        <ChatMoreMenu
          chat={shown}
          key={`menu-${shown.id}`}
          sourceNames={new Map()}
        />
      </>
    );
  };
  const rootRoute = createRootRoute({
    component: Shown,
    validateSearch: (search: Record<string, unknown>): { chat?: string } =>
      typeof search.chat === "string" ? { chat: search.chat } : {},
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [`/?chat=${chat.id}`] }),
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
  return {
    writes,
    router,
    answerWatch: async () => {
      answered.resolve(true);
      await settled();
    },
  };
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

/** Chooses the item `name` from the menu. */
const choose = async (name: string): Promise<void> => {
  await openMenu();
  await press(byRole("menuitem", name));
};

/** The chat's name, F2 away from renaming it. */
const titleButton = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>(
    '[data-slot="app-shell-panel-title"]'
  );
  if (found === null) {
    throw new Error("No title");
  }
  return found;
};

/** Opens the rename where the name stands, as F2 on it does. */
const startRename = async (): Promise<void> => {
  await act(async () => {
    titleButton().dispatchEvent(
      new KeyboardEvent("keydown", { key: "F2", bubbles: true })
    );
    await Promise.resolve();
  });
  await settled();
};

/** The rename's button `name`. */
const renameButton = (name: string): HTMLButtonElement => {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ].find((button) => button.textContent?.trim() === name);
  if (found === undefined) {
    throw new Error(`No button ${name} in the rename`);
  }
  return found;
};

/** The field the chat's new name is typed in. */
const nameField = (): HTMLInputElement => {
  const found = document.querySelector<HTMLInputElement>(
    'input[aria-label="Name"]'
  );
  if (found === null) {
    throw new Error("No name field");
  }
  return found;
};

/** Types `text` over what `field` holds, as typing does. */
const typeInto = async (field: HTMLInputElement, text: string) => {
  await act(async () => {
    // React tracks the value it set: the element's own setter, as typing
    // goes through, is what it hears change.
    Reflect.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

/** The dialog's button `name`. */
const dialogButton = (name: string): HTMLButtonElement => {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[role="alertdialog"] button'
    ),
  ].find((button) => button.textContent?.trim() === name);
  if (found === undefined) {
    throw new Error(`No button ${name} in the dialog`);
  }
  return found;
};

describe("the open chat's menu", () => {
  afterEach(async () => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    // The tab's watch of a chat stops a moment after its last reader goes:
    // the next test follows the same chat afresh.
    await settled();
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
    await opened(leave);
    await choose("Copy as Markdown");
    await settled();
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatch(/^# Leave/u);
    expect(copied[0]).toContain(question);
    expect(copied[0]).toContain(answer);
  });

  it("renames the chat where its name stands, to the name typed", async () => {
    const { writes } = await opened(leave);
    await startRename();
    const field = nameField();
    expect(field.value).toBe("Leave");
    await typeInto(field, "  Annual leave  ");
    await press(renameButton("Save"));
    expect(writes).toStrictEqual(["rename chat-1 Annual leave"]);
  });

  it("keeps the name as it was on Cancel, and renames nothing", async () => {
    const { writes } = await opened(leave);
    await startRename();
    await typeInto(nameField(), "Pay");
    await press(renameButton("Cancel"));
    expect(writes).toStrictEqual([]);
    expect(titleButton().textContent).toBe("Leave");
  });

  it("deletes the chat only once the person confirms, and leaves it for a new chat", async () => {
    setActiveChat("chat-1");
    const { writes, router } = await opened(leave);
    await choose("Delete");
    expect(writes).toStrictEqual([]);
    expect(
      document.querySelector('[role="alertdialog"]')?.textContent
    ).toContain("Delete “Leave”?");
    await press(dialogButton("Delete"));
    expect(writes).toStrictEqual(["remove chat-1"]);
    expect(activeChat()).toBeUndefined();
    expect(router.state.location.searchStr).toBe("");
  });

  it("copies and downloads nothing until the chat's messages are in", async () => {
    const { answerWatch } = await opened(leave, { slow: true });
    await openMenu();
    const disabled = (name: string): string | null =>
      byRole("menuitem", name).getAttribute("aria-disabled");
    const items = [
      "Copy as Markdown",
      "Download as Markdown",
      "Download as PDF",
    ];
    expect(items.map(disabled)).toStrictEqual(["true", "true", "true"]);

    await answerWatch();
    expect(items.map(disabled)).toStrictEqual([null, null, null]);
  });

  it("leaves the name being typed when another chat opens, renaming neither", async () => {
    const other: ChatSummary = { ...leave, id: "chat-2", title: "Pay" };
    const { writes, router } = await opened(leave, { others: [other] });
    await startRename();
    expect(document.querySelector('input[aria-label="Name"]')).not.toBeNull();

    act(() => {
      router.history.push("/?chat=chat-2");
    });
    await settled();
    expect(document.querySelector('input[aria-label="Name"]')).toBeNull();
    expect(titleButton().textContent).toBe("Pay");
    expect(writes).toStrictEqual([]);
  });
});
