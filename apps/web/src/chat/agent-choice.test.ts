import type { ChatAgent } from "@grasp-os/shared/chat";
import { describe, expect, it } from "vite-plus/test";

import { agentModelOf, agentOptions, startingAgent } from "./agent-choice.tsx";

// Which agent answers, in the box to ask in: what its plus menu offers,
// the one a new chat starts with, and the model an agent answers with.
// Choosing one in the menu, and the chat made with it, is covered where
// Chat's start is (chat-start.test.tsx).

const agent = (
  id: string,
  name: string,
  job = "",
  model: string | null = null
): ChatAgent => ({ id, name, face: "1", job, model });

const grasp = agent("organization", "Grasp");
const claire = agent(
  "agent-2",
  "Claire",
  "Chases unpaid invoices",
  "anthropic/claude-sonnet-5-5"
);

describe("which agent answers", () => {
  it("offers no choice to a person with one agent, or none", () => {
    expect([agentOptions([grasp]), agentOptions([])]).toStrictEqual([[], []]);
  });

  it("offers every agent by name, with what it is for, the company's first first", () => {
    expect(agentOptions([grasp, claire])).toStrictEqual([
      { value: "organization", label: "Grasp", avatar: true },
      {
        value: "agent-2",
        label: "Claire",
        avatar: true,
        description: "Chases unpaid invoices",
      },
    ]);
  });

  it("starts with the one picked while it is still the person's, else the first", () => {
    expect([
      startingAgent([grasp, claire], "agent-2")?.id,
      startingAgent([grasp, claire], "gone")?.id,
      agentModelOf([grasp, claire], "agent-2"),
    ]).toStrictEqual([
      "agent-2",
      "organization",
      "anthropic/claude-sonnet-5-5",
    ]);
  });
});
