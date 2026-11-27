// @vitest-environment happy-dom
import type { ChatMessage, ChatPartial } from "@grasp-os/shared/chat";
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

import type { PendingQuestion } from "./pending-question.ts";
import { ChatThread } from "./thread.tsx";

// The thread's rows as a question is sent and answered: the question drawn
// as it is sent and core's copy of it, which comes back with its key, are
// one row; the row Grasp works in stays the same row once its first reply
// is kept. Nothing is drawn again or moves.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const at = "2026-11-26T09:00:00.000Z";

const question = (id: number, key?: string): ChatMessage => ({
  id,
  role: "user",
  text: `Question ${id}`,
  ...(key === undefined ? {} : { key }),
  at,
});

const answer = (id: number): ChatMessage => ({
  id,
  role: "assistant",
  text: `Answer ${id}`,
  code: [],
  tools: [],
  end: "done",
  at,
});

const key = "6f1c1f0e-1c2b-4b4e-9d6e-0a7c4d3e2b1a";

const sent: PendingQuestion = {
  text: "Question 3",
  mentions: [],
  files: [],
  after: 2,
  at,
  queues: false,
  alreadyQueued: 0,
  key,
  owner: "box",
  fromBox: true,
  state: "sent",
};

const writing: ChatPartial = {
  text: "Ans",
  code: [],
  tools: [],
  reasoning: "",
};

interface Shown {
  messages: readonly ChatMessage[];
  pending: PendingQuestion | undefined;
  partial: ChatPartial | null;
  running: boolean;
}

let shown: Shown = {
  messages: [],
  pending: undefined,
  partial: null,
  running: false,
};
const listeners = new Set<() => void>();

const Page = () => {
  const now = useSyncExternalStore(
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
      messages={now.messages}
      onRetry={() => {
        // Not asked again here.
      }}
      output={null}
      partial={now.partial}
      pending={now.pending}
      running={now.running}
      sourceNames={new Map()}
    />
  );
};

const opened = async (first: Shown) => {
  shown = first;
  const router = createRouter({
    routeTree: createRootRoute({ component: Page }),
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

const show = async (next: Partial<Shown>) => {
  shown = { ...shown, ...next };
  await act(async () => {
    for (const listener of listeners) {
      listener();
    }
    await Promise.resolve();
  });
};

/** The thread's rows, in order, each as the element that draws it: its day lines left out. */
const rows = (): HTMLElement[] =>
  [
    ...document.querySelectorAll<HTMLElement>('[role="log"] [data-message-id]'),
  ].filter((row) => !(row.dataset.messageId ?? "").startsWith("day-"));

describe("the thread's rows as a question is sent and answered", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
  });

  it("keeps the question drawn as it was sent and the row Grasp works in as the same rows once core keeps the question and its first reply", async () => {
    const before = [question(1), answer(2)];
    await opened({
      messages: before,
      pending: sent,
      partial: null,
      running: true,
    });
    const [asked, working] = rows().slice(2);
    // Core's copy of the question comes back with its key, then the
    // answer's first reply is written and kept.
    await show({ messages: [...before, question(3, key)], pending: undefined });
    await show({ partial: writing });
    await show({
      messages: [...before, question(3, key), answer(4)],
      partial: null,
      running: false,
    });
    const [keptQuestion, keptAnswer] = rows().slice(2);

    expect({
      rows: rows().length,
      sameQuestion: keptQuestion === asked,
      sameAnswer: keptAnswer === working,
      answer: keptAnswer?.textContent.includes("Answer 4"),
    }).toStrictEqual({
      rows: 4,
      sameQuestion: true,
      sameAnswer: true,
      answer: true,
    });
  });
});
