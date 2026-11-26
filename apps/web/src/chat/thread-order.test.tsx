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

import type { SentQuestion } from "./sent-questions.ts";
import { ChatThread } from "./thread.tsx";

// The thread's order as a question is sent and answered: the question
// shows the moment it is sent, under its key, and stays the same row once
// core's copy comes back with that key; what Grasp writes stands under
// the question it answers, never in the answer before it, and stays the
// same row once its first reply is kept. Nothing moves or draws again.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const question = (id: number, key?: string): ChatMessage => ({
  id,
  role: "user",
  text: `Question ${id}`,
  ...(key === undefined ? {} : { key }),
  at: "2026-11-26T09:00:00.000Z",
});

const answer = (id: number): ChatMessage => ({
  id,
  role: "assistant",
  text: `Answer ${id}`,
  code: [],
  tools: [],
  end: "done",
  at: "2026-11-26T09:01:00.000Z",
});

const writing = (text: string): ChatPartial => ({
  text,
  code: [],
  tools: [],
  reasoning: "",
});

interface Shown {
  messages: readonly ChatMessage[];
  sent: readonly SentQuestion[];
  partial: ChatPartial | null;
  running: boolean;
}

let shown: Shown = { messages: [], sent: [], partial: null, running: false };
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
      running={now.running}
      sent={now.sent}
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

/** What each row says first: its question, or Grasp at work, or its answer. */
const said = (): string[] =>
  rows().map((row) => {
    const words = row.textContent;
    // One digit: the row's time of day follows its words. A row with
    // neither is Grasp at work, whatever its line says it does.
    return /(?:Question|Answer) \d/u.exec(words)?.[0] ?? "working";
  });

describe("the thread's order as a question is sent and answered", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("draws a question the moment it is sent, Grasp's work under it and never in the answer before, and keeps both rows as core shows them back", async () => {
    const before = [question(1), answer(2)];
    await opened({ messages: before, sent: [], partial: null, running: false });
    const key = "6f1c1f0e-1c2b-4b4e-9d6e-0a7c4d3e2b1a";
    const asked: SentQuestion = {
      key,
      text: "Question 3",
      at: "2026-11-26T09:02:00.000Z",
      behind: false,
      files: [],
      mentions: [],
    };

    // Sent: drawn at once, after what was there.
    await show({ sent: [asked] });
    const sentRows = rows();
    const atSend = said();
    // Core took it and works, before its copy of the question is back.
    await show({ running: true });
    const working = said();
    const workingRow = rows().at(-1);
    // Core's copy of the question comes back with its key, then the
    // answer's first reply is kept, then the answer ends.
    await show({ messages: [...before, question(3, key)], sent: [] });
    await show({ partial: writing("Ans") });
    await show({
      messages: [...before, question(3, key), answer(4)],
      partial: null,
      running: false,
    });

    expect({
      atSend,
      working,
      done: said(),
      // The same elements throughout: nothing drawn again, nothing moved.
      sameQuestion: rows()[2] === sentRows[2],
      sameAnswer: rows()[3] === workingRow,
    }).toStrictEqual({
      atSend: ["Question 1", "Answer 2", "Question 3"],
      working: ["Question 1", "Answer 2", "Question 3", "working"],
      done: ["Question 1", "Answer 2", "Question 3", "Answer 4"],
      sameQuestion: true,
      sameAnswer: true,
    });
  });

  it("keeps the row Grasp works in as the same row once its first reply is kept, for a question sent elsewhere too", async () => {
    await opened({
      messages: [question(1)],
      sent: [],
      partial: null,
      running: true,
    });
    const workingRow = rows().at(-1);
    await show({ messages: [question(1), answer(2)], running: false });

    expect({ done: said(), same: rows().at(-1) === workingRow }).toStrictEqual({
      done: ["Question 1", "Answer 2"],
      same: true,
    });
  });

  it("keeps a question core refused after the answer being written, never inside it", async () => {
    const refused: SentQuestion = {
      key: "2b0e5c1e-7a4f-4c5e-8d2f-9c3b1a0e6d4f",
      text: "Question 9",
      at: "2026-11-26T09:02:00.000Z",
      failure: "Grasp can't be reached right now.",
      behind: false,
      files: [],
      mentions: [],
    };
    await opened({
      messages: [question(1), answer(2)],
      sent: [refused],
      partial: null,
      running: false,
    });
    // An answer to the chat's last question goes on (sent elsewhere).
    await show({
      messages: [question(1), answer(2), question(3)],
      running: true,
    });
    const working = said();
    await show({
      messages: [question(1), answer(2), question(3), answer(4)],
      running: false,
    });

    expect({ working, done: said() }).toStrictEqual({
      working: [
        "Question 1",
        "Answer 2",
        "Question 3",
        "working",
        "Question 9",
      ],
      done: ["Question 1", "Answer 2", "Question 3", "Answer 4", "Question 9"],
    });
  });

  it("draws a question sent while Grasp answers after that answer, where core queues it", async () => {
    await opened({
      messages: [question(1)],
      sent: [],
      partial: writing("Ans"),
      running: true,
    });
    await show({
      sent: [
        {
          key: "8c1d4e2f-3a5b-4c6d-9e7f-0a1b2c3d4e5f",
          text: "Question 2",
          at: "2026-11-26T09:02:00.000Z",
          behind: true,
          files: [],
          mentions: [],
        },
      ],
    });

    expect(said()).toStrictEqual(["Question 1", "working", "Question 2"]);
  });
});
