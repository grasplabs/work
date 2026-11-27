// @vitest-environment happy-dom
import { setImmediate as nextTurn } from "node:timers/promises";

import type { ChatMessage, ChatUpdate } from "@grasp-os/shared/chat";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deadline, unlessAborted } from "../core.ts";
import { useFollowedChat } from "./chat-watch.ts";
import { useNewLine } from "./unread.ts";

// A chat open in a tab the person leaves (a phone locked, a laptop shut):
// the connection drops, an answer ends meanwhile, and they come back. The
// answer is read only once the tab has it again, with the New line over
// it; nothing is marked read past what the tab shows.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const message = (id: number): ChatMessage =>
  id % 2 === 1
    ? { id, role: "user", text: `Question ${id}`, at: "2026-11-26T09:00:00Z" }
    : {
        id,
        role: "assistant",
        text: `Answer ${id}`,
        code: [],
        tools: [],
        end: "done",
        at: "2026-11-26T09:01:00Z",
      };

/** Whether the tab is shown, as the page reads it. */
const showTab = (visible: boolean) => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (visible ? "visible" : "hidden"),
  });
  document.dispatchEvent(new Event("visibilitychange"));
};

/** What core keeps for a watch, until the page lets go of it. */
class Watching extends RpcTarget {
  released = false;

  release(): void {
    this.released = true;
  }
}

/** A watch's subscription as core hands it out: a stub that breaks with its connection. */
const subscription = () => {
  const { port1, port2 } = new MessageChannel();
  newMessagePortRpcSession(port1, new Watching());
  return {
    stub: newMessagePortRpcSession(port2),
    drop: () => {
      port1.postMessage(null);
    },
  };
};

const delivered = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn after another
    await nextTurn();
  }
};

/** Every line the chat drew. */
const lines: ReturnType<typeof useNewLine>[] = [];

const drew = (line: ReturnType<typeof useNewLine>): void => {
  lines.push(line);
};

const Page = () => {
  const { view } = useFollowedChat("chat-1");
  drew(useNewLine("chat-1", view, true));
  return null;
};

describe("a chat in a tab the person left", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    showTab(true);
  });

  it("draws the New line over an answer that ended while the tab was hidden and its connection dropped, reading it only once the tab has it", async () => {
    showTab(true);
    // Core: its messages, and where the person has read to.
    let stored = [message(1), message(2)];
    let readUpTo = 0;
    const reads: number[] = [];
    let connected = Promise.withResolvers<boolean>();
    connected.resolve(true);
    const subscriptions: ReturnType<typeof subscription>[] = [];
    // Watched again, core answers once the test lets it.
    const answered = Promise.withResolvers<boolean>();
    const chats = {
      watch: async (
        _chatId: string,
        after: number | null,
        onUpdate: (update: ChatUpdate) => void
      ) => {
        if (subscriptions.length > 0) {
          await answered.promise;
        }
        onUpdate({
          messages: stored.filter(({ id }) => id > (after ?? 0)),
          partial: null,
          running: false,
          stopped: null,
          held: 0,
          worked: 0,
        });
        const made = subscription();
        subscriptions.push(made);
        return await Promise.resolve(made.stub);
      },
      markRead: async (_chatId: string, upTo?: number) => {
        const before = readUpTo;
        const latest = stored.at(-1)?.id ?? 0;
        readUpTo = Math.max(readUpTo, Math.min(latest, upTo ?? latest));
        reads.push(readUpTo);
        return await Promise.resolve(before);
      },
    };
    const core = {
      withSession: async <T,>(
        run: (session: { chats: typeof chats }) => Promise<T>,
        signal = deadline()
      ): Promise<T> => {
        await unlessAborted(connected.promise, signal);
        return await run({ chats });
      },
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
    await vi.waitFor(() => {
      expect(lines.at(-1)).toStrictEqual({ decided: true, before: 2 });
    });

    // The tab hides; its connection drops; an answer ends meanwhile.
    act(() => {
      showTab(false);
    });
    connected = Promise.withResolvers<boolean>();
    await act(async () => {
      subscriptions[0]?.drop();
      await delivered();
    });
    stored = [...stored, message(3), message(4)];
    // Back on the tab before the connection is.
    await act(async () => {
      showTab(true);
      await delivered();
    });
    await act(async () => {
      connected.resolve(true);
      await delivered();
    });
    // Connected again, and the watch hasn't answered yet.
    const beforeAnswered = [...reads];
    await act(async () => {
      answered.resolve(true);
      await delivered();
    });
    await vi.waitFor(() => {
      expect(lines.at(-1)).toStrictEqual({ decided: true, before: 4 });
    });

    expect({ beforeAnswered, reads }).toStrictEqual({
      // Read up to what it showed as it opened; nothing while it was behind.
      beforeAnswered: [2],
      // Then up to the answer it has again, and only then.
      reads: [2, 4],
    });
  });
});
