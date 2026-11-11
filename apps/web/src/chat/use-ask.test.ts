import { describe, expect, it } from "vite-plus/test";

import { unsentChatFor } from "./use-ask.ts";

// Asking again after a question failed to send. These start from the way
// it can fail: the question going to the agent picked the first time
// after the person picked another one.

const unsent = { id: "chat-1", question: "Who owes us?", agentId: "claire" };

describe("asking again after a question failed to send", () => {
  it("asks in the chat made for it while the same agent is picked", () => {
    expect(unsentChatFor(unsent, "Who owes us?", "claire")).toBe("chat-1");
    expect(
      unsentChatFor({ ...unsent, agentId: undefined }, "Who owes us?")
    ).toBe("chat-1");
  });

  it("makes a new chat once another agent is picked, or another question asked", () => {
    expect(
      unsentChatFor(unsent, "Who owes us?", "organization")
    ).toBeUndefined();
    expect(unsentChatFor(unsent, "Who owes us?")).toBeUndefined();
    expect(unsentChatFor(unsent, "Something else", "claire")).toBeUndefined();
    expect(unsentChatFor(null, "Who owes us?", "claire")).toBeUndefined();
  });
});
