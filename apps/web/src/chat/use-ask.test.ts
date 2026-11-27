import { describe, expect, it } from "vite-plus/test";

import { askedWith, questionKeyFor } from "./use-ask.ts";

// Asking again after a question failed to send, which may have reached
// core with only its answer lost on the way: the same question goes with
// the same key, which core takes once. These start from the ways it can
// go wrong: a question changed since (another file, model, agent or chat)
// swallowed by core as the first one, or a key going to another chat
// (core refuses a key another chat took).

const asked = {
  question: "Who owes us?",
  chatId: undefined,
  agentId: "claire",
  model: "openai/gpt-5",
  effort: undefined,
  files: ["file-1"],
  mentions: [],
  subject: undefined,
};

const unsent = {
  key: "key-1",
  question: asked.question,
  asked: askedWith(asked),
};

describe("asking again after a question failed to send", () => {
  it("goes with the key it failed with when asked with all the same", () => {
    expect(
      questionKeyFor(unsent, asked.question, askedWith({ ...asked }))
    ).toBe("key-1");
  });

  it("goes with the key of a question taken back from another box while its words are the same, whatever else this box asks it with", () => {
    const takenBack = {
      key: "key-2",
      question: "Who owes us?",
      asked: undefined,
    };

    expect({
      same: questionKeyFor(
        takenBack,
        "Who owes us?",
        askedWith({ ...asked, chatId: "chat-1" })
      ),
      other:
        questionKeyFor(takenBack, "Who else?", askedWith(asked)) === "key-2",
    }).toStrictEqual({ same: "key-2", other: false });
  });

  it("goes with a new key once anything it is asked with changed", () => {
    const keys = [
      { question: "Something else" },
      { chatId: "chat-2" },
      { agentId: "organization" },
      { model: "anthropic/claude-sonnet-4-6" },
      { effort: "high" },
      { files: ["file-1", "file-2"] },
      { mentions: [{ kind: "agent", id: "claire" }] },
    ].map((changed) => {
      const now = { ...asked, ...changed };
      return questionKeyFor(unsent, now.question, askedWith(now));
    });
    keys.push(questionKeyFor(null, asked.question, unsent.asked));
    expect(keys).not.toContain("key-1");
    expect(new Set(keys).size).toBe(keys.length);
  });
});
