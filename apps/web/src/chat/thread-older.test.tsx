// @vitest-environment happy-dom
import type { ChatMessage } from "@grasp-os/shared/chat";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ChatThread } from "./thread.tsx";
import type { ThreadOlder } from "./thread.tsx";

// A long chat's thread holds its newest page; its earlier messages come in
// over it a page at a time as the person scrolls back, from the row over
// its first message. What was there stays the same rows, so nothing the
// person reads is drawn again (and nothing jumps): the page read goes in
// before them.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** Turn `n`: its question and answer, with IDs from `2n - 1`. */
const turn = (n: number): ChatMessage[] => [
  {
    id: 2 * n - 1,
    role: "user",
    text: `Question ${n}`,
    at: "2026-11-27T09:00:00.000Z",
  },
  {
    id: 2 * n,
    role: "assistant",
    text: `Answer ${n}`,
    code: [],
    tools: [],
    end: "done",
    at: "2026-11-27T09:00:05.000Z",
  },
];

/** What the thread shows now, and its readers. */
let shown: { messages: ChatMessage[]; older: ThreadOlder | undefined } = {
  messages: [],
  older: undefined,
};
const listeners = new Set<() => void>();

const show = async (next: typeof shown): Promise<void> => {
  shown = next;
  await act(async () => {
    for (const listener of listeners) {
      listener();
    }
    await Promise.resolve();
  });
};

const Thread = () => {
  const { messages, older } = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => shown
  );
  return (
    <ChatThread
      chatId="chat"
      loaded
      messages={messages}
      older={older}
      onRetry={() => {
        // Not asked again here.
      }}
      output={null}
      partial={null}
      running={false}
      sourceNames={new Map()}
    />
  );
};

const opened = async (): Promise<void> => {
  const router = createRouter({
    routeTree: createRootRoute({ component: Thread }),
    history: createMemoryHistory(),
    context: { core: {} },
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
};

/** The thread's rows that are messages, by the words they start with. */
const rows = (): Element[] => [
  ...document.querySelectorAll('[role="log"] article'),
];

/** The row over the first message, while the chat has earlier ones. */
const earlier = (): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="log"] button')].find(
    (button) => button.textContent.includes("arlier messages")
  );

describe("a long chat's thread, read back a page at a time", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("puts each earlier page in over the rows there, which stay the same rows, and has nothing more to read once the first message is in", async () => {
    const reads: string[] = [];
    const older = (reading = false): ThreadOlder => ({
      reading,
      failed: false,
      onRead: () => {
        reads.push("read");
      },
    });
    shown = { messages: [...turn(3), ...turn(4)], older: older() };
    await opened();
    const before = rows();
    const offered = earlier()?.textContent;
    await act(async () => {
      earlier()?.click();
      await Promise.resolve();
    });
    await show({ ...shown, older: older(true) });
    const reading = earlier();
    await show({
      messages: [...turn(1), ...turn(2), ...turn(3), ...turn(4)],
      older: undefined,
    });
    const after = rows();

    expect({
      offered,
      reads,
      reading: {
        label: reading?.textContent,
        disabled: reading?.disabled,
        busy: reading?.getAttribute("aria-busy"),
      },
      // The rows there before are the same elements, after the page read.
      kept: before.every((row) => after.includes(row)),
      order: after.map(
        (row) => /(?:Question|Answer) \d/u.exec(row.textContent)?.[0]
      ),
      more: earlier(),
    }).toStrictEqual({
      offered: "Earlier messages",
      reads: ["read"],
      reading: {
        label: "Loading earlier messages…",
        disabled: true,
        busy: "true",
      },
      kept: true,
      order: [...turn(1), ...turn(2), ...turn(3), ...turn(4)].map(
        ({ text }) => text
      ),
      more: undefined,
    });
  });
});
