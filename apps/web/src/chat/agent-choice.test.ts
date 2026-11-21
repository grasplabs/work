import type { ChatAgent } from "@grasp-os/shared/chat";
import { describe, expect, it } from "vite-plus/test";

import { agentModelOf } from "./agent-choice.tsx";

const stephen: ChatAgent = {
  id: "organization",
  name: "Stephen",
  face: "stephen",
  job: "Answers from what the company told Grasp.",
  model: null,
  own: false,
};
const claire: ChatAgent = {
  id: "agent-claire",
  name: "Claire",
  face: "claire",
  job: "Chases unpaid invoices.",
  model: "anthropic/claude-sonnet-5-5",
  own: false,
};

describe("which agent answers, in the box to ask in", () => {
  it("answers with the model an admin gave the agent, else the asker's", () => {
    expect([
      agentModelOf([stephen, claire], claire.id),
      agentModelOf([stephen, claire], stephen.id),
      agentModelOf([stephen, claire], "agent-gone"),
    ]).toStrictEqual(["anthropic/claude-sonnet-5-5", undefined, undefined]);
  });
});
