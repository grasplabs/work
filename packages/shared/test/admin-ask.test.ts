import { describe, expect, it } from "vite-plus/test";

import { adminAskRequestSchema, turnsOf } from "../src/admin-ask.ts";

const asked = (turns: unknown[]) =>
  adminAskRequestSchema.safeParse({
    sentAt: new Date().toISOString(),
    staff: { email: "ada@grasp.test" },
    document: "# Grasp's admin",
    turns,
  }).success;

describe("Ask Grasp's conversation", () => {
  it("keeps what has words, and of two in a row from one side the later, never starting with an answer", () => {
    expect(
      turnsOf([
        { role: "assistant", text: "Hello." },
        { role: "user", text: "First, not answered" },
        { role: "user", text: "Which company?" },
        { role: "assistant", text: "  " },
        { role: "assistant", text: "Noordkade." },
        { role: "system", text: "ignored" },
        { role: "user", text: "Why?" },
      ])
    ).toStrictEqual([
      { role: "user", text: "Which company?" },
      { role: "assistant", text: "Noordkade." },
      { role: "user", text: "Why?" },
    ]);
  });

  it("takes only a conversation that takes turns, starting and ending with a question", () => {
    expect([
      asked([{ role: "user", text: "Which company?" }]),
      asked([
        { role: "user", text: "Which?" },
        { role: "assistant", text: "Noordkade." },
      ]),
      asked([
        { role: "user", text: "Which?" },
        { role: "user", text: "And?" },
      ]),
      asked([{ role: "assistant", text: "Noordkade." }]),
      asked([]),
      asked([{ role: "user", text: "x".repeat(8001) }]),
    ]).toStrictEqual([true, false, false, false, false, false]);
  });
});
