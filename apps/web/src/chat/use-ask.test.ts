import { describe, expect, it } from "vite-plus/test";

import { questionKeyFor } from "./use-ask.ts";

// Asking again after a question failed to send, which may have reached
// core with only its answer lost on the way: the same question goes with
// the same key, which core takes once. These start from the ways it can
// go wrong: the key going to another chat (core refuses a key another
// chat took), or to a new chat with the agent picked after the first try.

const unsent = {
  key: "key-1",
  question: "Who owes us?",
  chatId: undefined,
  agentId: "claire",
};

describe("asking again after a question failed to send", () => {
  it("goes with the key it failed with, in the same chat, with the same agent", () => {
    expect(questionKeyFor(unsent, "Who owes us?", undefined, "claire")).toBe(
      "key-1"
    );
    expect(
      questionKeyFor(
        { ...unsent, chatId: "chat-1", agentId: undefined },
        "Who owes us?",
        "chat-1"
      )
    ).toBe("key-1");
  });

  it("goes with a new key in another chat, with another agent, or for another question", () => {
    const keys = [
      questionKeyFor(unsent, "Who owes us?", undefined, "organization"),
      questionKeyFor(unsent, "Who owes us?"),
      questionKeyFor(unsent, "Who owes us?", "chat-2", "claire"),
      questionKeyFor(unsent, "Something else", undefined, "claire"),
      questionKeyFor(null, "Who owes us?", undefined, "claire"),
    ];
    expect(keys).not.toContain("key-1");
    expect(new Set(keys).size).toBe(keys.length);
  });
});
