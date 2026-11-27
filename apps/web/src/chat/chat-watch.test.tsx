// @vitest-environment happy-dom
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

const View = ({ name }: { name: string }) => {
  const { view } = useFollowedChat("chat-1");
  drew(name, useNewLine("chat-1", view, true));
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
});
