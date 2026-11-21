import type { AgentDrafted } from "@grasp-os/shared/agents";
import type {
  ChatAsked,
  ChatMessage,
  ChatPlanned,
} from "@grasp-os/shared/chat";
import { describe, expect, it } from "vite-plus/test";

import { sourcesGiveWay } from "./chat-body.tsx";

// When the fold of what the chat's answers drew on gives way over the box:
// to the agent's questions, or to a card that waits for the person.

const at = "2026-11-18T09:00:00.000Z";

const asked: ChatMessage = {
  id: 1,
  role: "user",
  text: "What is our expense policy?",
  at,
};

const answer = (
  more: Partial<Extract<ChatMessage, { role: "assistant" }>> = {}
): ChatMessage => ({
  id: 2,
  role: "assistant",
  text: "Receipts within a month.",
  code: [],
  tools: [],
  end: "done",
  at,
  ...more,
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

const plan: ChatPlanned = {
  callId: "call-plan",
  parts: [{ kind: "app", name: "Desk", does: "Open questions." }],
  who: "Just me",
};

const draft: AgentDrafted = {
  callId: "call-draft",
  name: "HR helper",
  job: "Checks HR's mail.",
  instructions: "Sum up HR's mail.",
  whose: "own",
};

describe("the sources fold over the box", () => {
  it("stands under an answer with nothing asked and no card waiting, and while the chat works on a card", () => {
    expect([
      sourcesGiveWay([asked, answer()], false),
      sourcesGiveWay([asked, answer({ planned: plan })], true),
    ]).toStrictEqual([false, false]);
  });

  it("gives way to the agent's questions, a plan that waits and an agent drafted that waits", () => {
    expect([
      sourcesGiveWay([asked, answer()], false, question),
      sourcesGiveWay([asked, answer({ planned: plan })], false),
      sourcesGiveWay([asked, answer({ agentDraft: draft })], false),
    ]).toStrictEqual([true, true, true]);
  });
});
