// @vitest-environment happy-dom
import type {
  ChatMessage,
  ChatPartial,
  ChatToolEvent,
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
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ChatThread } from "./thread.tsx";

// An answer's steps as one trace in the thread. What the model thought:
// while it thinks, its words stream in, open under "Thinking"; once the
// answer is kept, a quiet line says how long it thought, folded, and opens
// to what it thought. How long Grasp worked is the trace's first line. And
// what an answer's code did to the dashboard, under the step that did it.
// While an answer is written, its words fade in where they land; a kept
// one stands still.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const asked: ChatMessage = {
  id: 1,
  role: "user",
  text: "What is 2 + 2?",
  at: "2026-10-27T09:00:00.000Z",
};

/**
 * The thread of `messages`, with `partial` being written while it runs,
 * and the calls its code made (`tools`), on a page of its own.
 */
const thread = async (
  messages: readonly ChatMessage[],
  partial: ChatPartial | null = null,
  tools: readonly ChatToolEvent[] = []
): Promise<void> => {
  const page = createRootRoute({
    component: () => (
      <ChatThread
        chatId="chat"
        loaded
        messages={messages}
        onRetry={() => {
          // Not asked again here.
        }}
        output={null}
        partial={partial}
        running={partial !== null}
        tools={tools}
      />
    ),
  });
  const router = createRouter({
    routeTree: page,
    history: createMemoryHistory(),
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

/** The first step that folds open: its line, whether it is open, and what it shows. */
const firstStep = () => {
  const line = document.querySelector("button[aria-expanded]");
  const shows = line?.getAttribute("aria-controls");
  return {
    line: line?.textContent,
    open: line?.getAttribute("aria-expanded") === "true",
    shows:
      shows === null || shows === undefined
        ? undefined
        : document.querySelector(`#${shows}`)?.textContent,
  };
};

describe(ChatThread, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("streams what the model thinks, open under Thinking, before it says a word", async () => {
    await thread([asked], {
      text: "",
      code: [],
      reasoning: "Add two to two.",
    });

    expect(firstStep()).toStrictEqual({
      line: "Thinking",
      open: true,
      shows: "Add two to two.",
    });
  });

  it("says over a kept answer how long the model thought, and unfolds what it thought", async () => {
    await thread([
      asked,
      {
        id: 2,
        role: "assistant",
        text: "Four.",
        citations: [],
        code: [],
        reasoning: { text: "Add two to two.", ms: 3400 },
        end: "done",
        at: "2026-10-27T09:00:05.000Z",
      },
    ]);
    const folded = firstStep();
    await act(async () => {
      document.querySelector<HTMLElement>("button[aria-expanded]")?.click();
      await Promise.resolve();
    });

    expect([folded, firstStep()]).toStrictEqual([
      { line: "Thought for 3s", open: false, shows: undefined },
      { line: "Thought for 3s", open: true, shows: "Add two to two." },
    ]);
  });

  it("says under a code step each widget it made or changed on the dashboard, with the way there", async () => {
    const at = "2026-10-27T09:00:05.000Z";
    await thread(
      [
        asked,
        {
          id: 2,
          role: "assistant",
          text: "",
          citations: [],
          code: [{ callId: "step", code: "await env.dashboard.makeWidget()" }],
          end: "done",
          at,
        },
        {
          id: 3,
          role: "result",
          callId: "step",
          text: "done",
          failed: false,
          at,
        },
      ],
      null,
      [
        {
          id: 1,
          callId: "step",
          method: "dashboard.makeWidget",
          target: null,
          summary: {},
          outcome: "ok",
          reason: null,
          at,
        },
      ]
    );
    const way = document.querySelector('a[href="/dashboard"]');

    expect({
      said: way?.parentElement?.textContent,
      step: document.querySelector("button[aria-expanded]")?.textContent,
    }).toStrictEqual({
      said: "Grasp added a widget to your dashboard. Open the dashboard",
      step: "Code stepDone",
    });
  });

  it("fades each word of an answer in as it is written, and a kept answer stands still", async () => {
    await thread([asked], {
      text: "Four, as **two** and two.",
      code: [],
      reasoning: "",
    });
    const landing = [...document.querySelectorAll("span.animate-in")].map(
      (word) => word.textContent
    );
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await thread([
      asked,
      {
        id: 2,
        role: "assistant",
        text: "Four, as **two** and two.",
        citations: [],
        code: [],
        end: "done",
        at: "2026-10-27T09:00:05.000Z",
      },
    ]);

    expect({
      landing,
      kept: document.querySelectorAll("span.animate-in").length,
    }).toStrictEqual({
      landing: ["Four,", "as", "two", "and", "two."],
      kept: 0,
    });
  });
});
