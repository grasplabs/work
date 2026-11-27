// @vitest-environment happy-dom
import { setTimeout as sleep } from "node:timers/promises";

import { agentErrors } from "@grasp-os/shared/agent";
import type { ChatMessage, ChatUpdate } from "@grasp-os/shared/chat";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { starting, startTried } from "./chat-starts.ts";
import { useFollowedChat } from "./chat-watch.ts";
import { useNewLine } from "./unread.ts";

// One chat shown twice from the tab's one watch of it, as its page and the
// dock beside another page are: what the person read in the first is read
// in the second, which draws no New line over it.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const messages: ChatMessage[] = [
  { id: 1, role: "user", text: "Question 1", at: "2026-11-26T09:00:00.000Z" },
  {
    id: 2,
    role: "assistant",
    text: "Answer 2",
    code: [],
    tools: [],
    end: "done",
    at: "2026-11-26T09:01:00.000Z",
  },
];

/** The lines each view of the chat drew, by view. */
const lines: Record<string, ReturnType<typeof useNewLine>[]> = {};

const drew = (name: string, line: ReturnType<typeof useNewLine>): void => {
  lines[name] = [...(lines[name] ?? []), line];
};

/** The chat the views show. */
let shownChat = "chat-1";

const View = ({ name }: { name: string }) => {
  const { view } = useFollowedChat(shownChat);
  drew(name, useNewLine(shownChat, view, true));
  return null;
};

/** Which views show the chat now. */
let views: string[] = [];
const listeners = new Set<() => void>();

const Page = () => {
  const shown = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => views
  );
  return shown.map((name) => <View key={name} name={name} />);
};

/** Shows `next` views of the chat. */
const showViews = async (next: string[]) => {
  views = next;
  await act(async () => {
    for (const listener of listeners) {
      listener();
    }
    await Promise.resolve();
  });
};

/** The views against a core whose chats are `chats`. */
const opened = async (chats: object) => {
  const core = {
    withSession: async <T,>(
      run: (session: { chats: object }) => Promise<T>
    ): Promise<T> => await run({ chats }),
  };
  const router = createRouter({
    routeTree: createRootRoute({ component: Page }),
    history: createMemoryHistory(),
    context: { core },
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<RouterProvider router={router} />);
    await router.load();
  });
};

describe("a chat shown twice from one watch", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
  });

  it("draws no New line in a second view over what the person read in the first", async () => {
    const markRead = vi.fn<(chatId: string, upTo?: number) => Promise<number>>(
      async () => await Promise.resolve(0)
    );
    const chats = {
      watch: async (
        _chatId: string,
        _after: number | null,
        onUpdate: (update: ChatUpdate) => void
      ) => {
        onUpdate({
          messages,
          partial: null,
          running: false,
          stopped: null,
          held: 0,
          worked: 0,
          seenUpTo: 0,
        });
        return await Promise.withResolvers<never>().promise;
      },
      markRead,
    };
    const core = {
      withSession: async <T,>(
        run: (session: { chats: typeof chats }) => Promise<T>
      ): Promise<T> => await run({ chats }),
    };
    views = ["page"];
    const router = createRouter({
      routeTree: createRootRoute({ component: Page }),
      history: createMemoryHistory(),
      context: { core },
    });
    const host = document.createElement("div");
    document.body.append(host);
    await act(async () => {
      root = createRoot(host);
      root.render(<RouterProvider router={router} />);
      await router.load();
    });
    await vi.waitFor(() => {
      expect(markRead).toHaveBeenCalledWith("chat-1", 2);
    });
    await act(async () => {
      await Promise.resolve();
    });
    // The dock opens on it beside another page, from the same watch.
    views = ["dock"];
    await act(async () => {
      for (const listener of listeners) {
        listener();
      }
      await Promise.resolve();
    });

    expect({
      page: lines.page?.at(-1),
      dock: lines.dock?.find(({ decided }) => decided),
    }).toStrictEqual({
      page: { decided: true, before: 2 },
      dock: { decided: true, before: undefined },
    });
  });

  it("draws the New line over an answer that ended while the chat wasn't shown, coming back to the view the tab kept of it", async () => {
    shownChat = "chat-2";
    let watches = 0;
    let readUpTo = 0;
    const markRead = vi.fn<(chatId: string) => Promise<number>>(async () => {
      const before = readUpTo;
      // Core marks the latest it has: the question, then the answer.
      readUpTo = watches === 1 ? 1 : 2;
      return await Promise.resolve(before);
    });
    const chats = {
      watch: async (
        _chatId: string,
        _after: number | null,
        onUpdate: (update: ChatUpdate) => void
      ) => {
        watches += 1;
        // Left while the answer was written; back once it was done.
        onUpdate({
          messages: watches === 1 ? messages.slice(0, 1) : messages,
          partial: null,
          running: watches === 1,
          stopped: null,
          held: 0,
          worked: 0,
          seenUpTo: readUpTo,
        });
        return await Promise.withResolvers<never>().promise;
      },
      markRead,
    };
    views = ["first"];
    await opened(chats);
    await vi.waitFor(() => {
      expect(markRead).toHaveBeenCalledOnce();
    });
    await showViews([]);
    // Its watch stops a moment after; the tab keeps its view.
    await act(async () => {
      await sleep(10);
    });
    await showViews(["back"]);
    await vi.waitFor(() => {
      expect(lines.back?.at(-1)).toStrictEqual({ decided: true, before: 2 });
    });
  });

  it("marks nothing read from the view the tab kept of a chat, only once core's view of it is there", async () => {
    shownChat = "chat-3";
    let watches = 0;
    const markRead = vi.fn<(chatId: string) => Promise<number>>(
      async () => await Promise.resolve(0)
    );
    const chats = {
      watch: async (
        _chatId: string,
        _after: number | null,
        onUpdate: (update: ChatUpdate) => void
      ) => {
        watches += 1;
        // Coming back, core's watch hasn't answered yet.
        if (watches > 1) {
          return await Promise.withResolvers<never>().promise;
        }
        onUpdate({
          messages,
          partial: null,
          running: false,
          stopped: null,
          held: 0,
          worked: 0,
          seenUpTo: 2,
        });
        return await Promise.withResolvers<never>().promise;
      },
      markRead,
    };
    views = ["first"];
    await opened(chats);
    await vi.waitFor(() => {
      expect(markRead).toHaveBeenCalledOnce();
    });
    await showViews([]);
    await act(async () => {
      await sleep(10);
    });
    await showViews(["again"]);
    await act(async () => {
      await sleep(10);
    });

    expect({
      shown: lines.again?.length !== undefined,
      marks: markRead.mock.calls.length,
    }).toStrictEqual({ shown: true, marks: 1 });
  });

  it("follows a chat the tab is starting once its question is done, even one that failed here though core made the chat, never not found meanwhile", async () => {
    shownChat = crypto.randomUUID();
    const followed: { gone: boolean | undefined; messages: number }[] = [];
    const Starting = () => {
      const { view, gone } = useFollowedChat(shownChat);
      followed.push({ gone, messages: view.messages.length });
      return null;
    };
    let watches = 0;
    const chats = {
      watch: async (
        _chatId: string,
        _after: number | null,
        onUpdate: (update: ChatUpdate) => void
      ) => {
        watches += 1;
        // Core has no such chat until its first question made it.
        if (watches === 1) {
          throw agentErrors.create("agent.chat_not_found");
        }
        onUpdate({
          messages,
          partial: null,
          running: false,
          stopped: null,
          held: 0,
          worked: 0,
          seenUpTo: 2,
        });
        return await Promise.withResolvers<never>().promise;
      },
    };
    starting(shownChat, { key: crypto.randomUUID(), title: "Question 1" });
    const core = {
      withSession: async <T,>(
        run: (session: { chats: typeof chats }) => Promise<T>
      ): Promise<T> => await run({ chats }),
    };
    const router = createRouter({
      routeTree: createRootRoute({ component: Starting }),
      history: createMemoryHistory(),
      context: { core },
    });
    const host = document.createElement("div");
    document.body.append(host);
    await act(async () => {
      root = createRoot(host);
      root.render(<RouterProvider router={router} />);
      await router.load();
    });
    await vi.waitFor(() => {
      expect(watches).toBe(1);
    });
    const meanwhile = followed.at(-1);
    // Its question failed here, its answer lost on the way: core made it.
    await act(async () => {
      startTried(shownChat);
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(followed.at(-1)?.messages).toBe(2);
    });

    expect({
      meanwhile,
      everGone: followed.some(({ gone }) => gone === true),
      watches,
    }).toStrictEqual({
      meanwhile: { gone: undefined, messages: 0 },
      everGone: false,
      watches: 2,
    });
  });
});
