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

// What the model thought before an answer, in the thread: while it thinks,
// its words stream in, open under "Thinking"; once the answer is kept, a
// quiet line says how long it thought, and unfolds what it thought. And
// what an answer's code did to the dashboard, under the step that did it.

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

/** What the thread shows of the model's thinking: its line, whether it is open, and what it thought. */
const thinking = () => {
  const details = document.querySelector("details");
  return {
    line: details?.querySelector("summary")?.textContent,
    open: details?.open,
    thought: details?.querySelector("p")?.textContent,
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

    expect(thinking()).toStrictEqual({
      line: "Thinking",
      open: true,
      thought: "Add two to two.",
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
    const folded = thinking();
    await act(async () => {
      document.querySelector("summary")?.click();
      await Promise.resolve();
    });

    expect([folded, thinking()]).toStrictEqual([
      { line: "Thought for 3s", open: false, thought: "Add two to two." },
      { line: "Thought for 3s", open: true, thought: "Add two to two." },
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
    const line = [...document.querySelectorAll("p")].find((each) =>
      each.textContent.includes("dashboard")
    );

    expect({
      said: line?.textContent,
      to: line?.querySelector("a")?.getAttribute("href"),
    }).toStrictEqual({
      said: "Grasp added a widget to your dashboard. Open the dashboard",
      to: "/dashboard",
    });
  });
});
