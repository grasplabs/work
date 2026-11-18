import type { ChatAsked, ChatMessage } from "@grasp-os/shared/chat";
import { describe, expect, it } from "vite-plus/test";

import { sourcesGiveWay } from "./chat-body.tsx";

// When the fold of what the chat's answers drew on gives way over the box:
// to the agent's questions, a plan that waits, or the last answer's own
// sources right above it.

const asked: ChatMessage = {
  id: 1,
  role: "user",
  text: "What is our expense policy?",
  at: "2026-11-18T09:00:00.000Z",
};

const answer = (cited: boolean): ChatMessage => ({
  id: 2,
  role: "assistant",
  text: "Receipts within a month.",
  citations: cited ? [{ kind: "document", documentId: "doc-1" }] : [],
  code: [],
  tools: [],
  end: "done",
  at: "2026-11-18T09:00:05.000Z",
});

const question: ChatAsked = {
  callId: "ask-1",
  questions: [
    {
      kind: "choice",
      question: "Which staff?",
      options: [{ label: "Dutch staff" }, { label: "German staff" }],
    },
  ],
};

describe("the sources fold over the box", () => {
  it("stands under an answer without sources of its own, with nothing asked or planned", () => {
    expect(
      sourcesGiveWay([asked, answer(false)], undefined, false)
    ).toBeFalsy();
  });

  it("gives way to the last answer's own sources, the agent's questions, and a plan that waits", () => {
    expect([
      sourcesGiveWay([asked, answer(true)], undefined, false),
      sourcesGiveWay([asked, answer(false)], question, false),
      sourcesGiveWay([asked, answer(false)], undefined, true),
    ]).toStrictEqual([true, true, true]);
  });
});
