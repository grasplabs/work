// @vitest-environment happy-dom
import type { ChatMessage, ChatPartial } from "@grasp-os/shared/chat";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ChatThread } from "./thread.tsx";

// What the model thought before an answer, in the thread: while it thinks,
// its words stream in, open under "Thinking"; once the answer is kept, a
// quiet line says how long it thought, and unfolds what it thought.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const asked: ChatMessage = {
  id: 1,
  role: "user",
  text: "What is 2 + 2?",
  at: "2026-10-27T09:00:00.000Z",
};

/** The thread of `messages`, with `partial` being written while it runs. */
const thread = async (
  messages: readonly ChatMessage[],
  partial: ChatPartial | null = null
): Promise<void> => {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
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
        />
      </I18nProvider>
    );
    await Promise.resolve();
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
});
