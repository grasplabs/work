import type { AgentDrafted } from "@grasp-os/shared/agents";
import type { ChatMessage, ChatPlanned } from "@grasp-os/shared/chat";
import { describe, expect, it } from "vite-plus/test";

import { pendingCard } from "./make-card.tsx";

// When a card the chat proposed waits for the person: one rule for a
// plan, a drafted agent and a change to one.

const at = "2026-11-17T09:00:00.000Z";

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

const said = (id: number): ChatMessage => ({
  id,
  role: "user",
  text: "Something else.",
  at,
});

const reply = (
  id: number,
  more: Partial<Extract<ChatMessage, { role: "assistant" }>>
): ChatMessage => ({
  id,
  role: "assistant",
  text: "",
  code: [],
  tools: [],
  end: "done",
  at,
  ...more,
});

describe("the card that waits for the person", () => {
  it("is the latest reply's, whichever kind it is, never an earlier one, none once something was said, and none while the chat works", () => {
    const planThenDraft = [
      reply(1, { planned: plan }),
      said(2),
      reply(3, { agentDraft: draft }),
    ];
    expect({
      latest: pendingCard(planThenDraft, false),
      plan: pendingCard([reply(1, { planned: plan })], false),
      saidSince: pendingCard([reply(1, { planned: plan }), said(2)], false),
      running: pendingCard(planThenDraft, true),
    }).toStrictEqual({
      latest: { kind: "agentDraft", callId: "call-draft" },
      plan: { kind: "planned", callId: "call-plan" },
      saidSince: undefined,
      running: undefined,
    });
  });
});
