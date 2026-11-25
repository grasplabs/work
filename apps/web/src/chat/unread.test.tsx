// @vitest-environment happy-dom
import type { ChatMessage } from "@grasp-os/shared/chat";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { AnyRouter } from "@tanstack/react-router";
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { onChatsChanged } from "./chats-changed.ts";
import { firstUnseenAnswer, opensAtNewLine, useNewLine } from "./unread.ts";

// Where the person has read a chat to. These start from the ways it can
// go wrong: an answer they watched arrive is drawn as new, or left unread
// on core; the New line moves, or goes, while the chat stays open; their
// own question is taken for news; a chat in a hidden tab is marked read.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const question = (id: number): ChatMessage => ({
  id,
  role: "user",
  text: `Question ${id}`,
  at: "2026-11-25T09:00:00.000Z",
});

const answer = (id: number): ChatMessage => ({
  id,
  role: "assistant",
  text: `Answer ${id}`,
  code: [],
  tools: [],
  end: "done",
  at: "2026-11-25T09:01:00.000Z",
});

interface View {
  messages: readonly ChatMessage[];
  running: boolean;
  loaded: boolean;
}

/** Whether a thread whose rows are `height` tall opens at its line: a view 600px tall, the line 900px down. */
const opensAt = (height: number) =>
  opensAtNewLine({ lineTop: 900, height, view: 600 });

/** Whether the tab is shown, as the page reads it. */
const showTab = (shown: boolean) => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (shown ? "visible" : "hidden"),
  });
  document.dispatchEvent(new Event("visibilitychange"));
};

/** The chat's view as the page shows it now, and who reads it. */
const shownChat: { view: View; listeners: Set<() => void> } = {
  view: { messages: [], running: false, loaded: false },
  listeners: new Set(),
};

const subscribe = (listener: () => void) => {
  shownChat.listeners.add(listener);
  return () => {
    shownChat.listeners.delete(listener);
  };
};

/** Every line the hook gave, after each render. */
const lines: ReturnType<typeof useNewLine>[] = [];

/** Chat `chat-1` open with what the page shows of it. */
const Page = () => {
  const view = useSyncExternalStore(subscribe, () => shownChat.view);
  lines.push(useNewLine("chat-1", view));
  return null;
};

/**
 * Chat `chat-1` open with `view`, against a core whose `markRead` answers
 * where the person had read to, `seenUpTo`, the first time, and the latest
 * message after: what the hook gives, and each mark.
 */
const opened = async (view: View, seenUpTo: number | null) => {
  shownChat.view = view;
  lines.length = 0;
  let latestMarked: number | null = seenUpTo;
  const markRead = vi.fn<(chatId: string) => Promise<number | null>>(
    async (chatId) => {
      await Promise.resolve();
      const before = latestMarked;
      latestMarked = shownChat.view.messages.at(-1)?.id ?? before;
      return chatId === "chat-1" ? before : null;
    }
  );
  const session = { chats: { markRead } };
  const core = {
    withSession: async <T,>(
      action: (reached: typeof session) => Promise<T>
    ): Promise<T> => await action(session),
  };
  const router: AnyRouter = createRouter({
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
  return {
    markRead,
    line: () => lines.at(-1),
    show: async (next: View) => {
      shownChat.view = next;
      await act(async () => {
        for (const listener of shownChat.listeners) {
          listener();
        }
        await Promise.resolve();
      });
    },
  };
};

describe("where the person has read a chat to", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    showTab(true);
  });

  it("finds the first answer after what was seen, never the person's own question", () => {
    const messages = [question(1), answer(2), question(3), answer(4)];
    expect({
      none: firstUnseenAnswer(messages, null),
      afterAnswer: firstUnseenAnswer(messages, 2),
      afterOwnQuestion: firstUnseenAnswer(messages, 3),
      allSeen: firstUnseenAnswer(messages, 4),
      ownQuestionOnly: firstUnseenAnswer(
        [question(1), answer(2), question(3)],
        2
      ),
    }).toStrictEqual({
      none: 2,
      afterAnswer: 4,
      afterOwnQuestion: 4,
      allSeen: undefined,
      ownQuestionOnly: undefined,
    });
  });

  it("opens at the New line only when what is unread is taller than the view, and at the end when it fits", () => {
    expect({
      longer: opensAt(2000),
      fitsExactly: opensAt(1500),
      fits: opensAt(1400),
    }).toStrictEqual({ longer: true, fitsExactly: false, fits: false });
  });

  it("marks a chat read as it opens, and draws the New line over the first answer it hadn't seen, only once core said where it was read to", async () => {
    showTab(true);
    const told = vi.fn<() => void>();
    const unheard = onChatsChanged(told);
    const view = {
      messages: [question(1), answer(2), question(3), answer(4)],
      running: false,
      loaded: true,
    };
    const chat = await opened(view, 2);

    await vi.waitFor(() => {
      expect(chat.line()).toStrictEqual({ decided: true, before: 4 });
    });
    unheard();
    // Loading until core answered, so the thread opens where the line is.
    expect({
      first: lines[0],
      marked: chat.markRead.mock.calls[0],
      told: told.mock.calls.length > 0,
    }).toStrictEqual({
      first: { decided: false, before: undefined },
      marked: ["chat-1"],
      told: true,
    });
  });

  it("keeps the New line where it is while the chat stays open, and draws none for an answer the person watched arrive, which is read as it ends", async () => {
    showTab(true);
    const view = {
      messages: [question(1), answer(2)],
      running: false,
      loaded: true,
    };
    const chat = await opened(view, null);
    await vi.waitFor(() => {
      expect(chat.line()).toStrictEqual({ decided: true, before: 2 });
    });
    const marksAtOpen = chat.markRead.mock.calls.length;

    // They ask, and watch the answer come and end.
    await chat.show({
      ...view,
      messages: [...view.messages, question(3)],
      running: true,
    });
    await chat.show({
      ...view,
      messages: [...view.messages, question(3), answer(4)],
      running: false,
    });

    await vi.waitFor(() => {
      expect(chat.markRead.mock.calls.length).toBeGreaterThan(marksAtOpen);
    });
    expect(chat.line()).toStrictEqual({ decided: true, before: 2 });
  });

  it("draws no New line for a chat whose agent works as it opens: a question just asked here, whose answer the person watches come", async () => {
    showTab(true);
    const view = {
      messages: [question(1), answer(2)],
      running: true,
      loaded: true,
    };
    const chat = await opened(view, null);
    await vi.waitFor(() => {
      expect(chat.line()).toStrictEqual({ decided: true, before: undefined });
    });
  });

  it("opens with no New line when nothing is unread", async () => {
    showTab(true);
    const view = {
      messages: [question(1), answer(2)],
      running: false,
      loaded: true,
    };
    const chat = await opened(view, 2);
    await vi.waitFor(() => {
      expect(chat.line()).toStrictEqual({ decided: true, before: undefined });
    });
  });

  it("marks nothing read in a hidden tab, opening at once with no line, and marks it read once the tab is shown", async () => {
    showTab(false);
    const view = {
      messages: [question(1), answer(2)],
      running: false,
      loaded: true,
    };
    const chat = await opened(view, null);
    const hidden = {
      line: chat.line(),
      marks: chat.markRead.mock.calls.length,
    };

    await act(async () => {
      showTab(true);
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(chat.markRead).toHaveBeenCalledWith("chat-1");
    });
    expect({ hidden, shown: chat.line() }).toStrictEqual({
      hidden: { line: { decided: true, before: undefined }, marks: 0 },
      shown: { decided: true, before: undefined },
    });
  });
});
