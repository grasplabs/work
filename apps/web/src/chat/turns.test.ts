import type { ChatMessage } from "@grasp-os/shared/chat";
import { describe, expect, it } from "vite-plus/test";

import { shortTime, turnsOf, workedFor } from "./turns.ts";

// How long Grasp worked on each question, from when it was asked to its
// last answer (turns.ts).

const asked = (id: number, at: string): ChatMessage => ({
  id,
  role: "user",
  text: "How many open invoices?",
  at,
});
const answer = (id: number, at: string, code = false): ChatMessage => ({
  id,
  role: "assistant",
  text: code ? "" : "Twelve.",
  code: code ? [{ callId: `call-${id}`, code: "return 12;" }] : [],
  tools: [],
  end: "done",
  at,
});
const result = (id: number, at: string): ChatMessage => ({
  id,
  role: "result",
  callId: `call-${id - 1}`,
  text: "12",
  failed: false,
  at,
});

describe("how long Grasp worked", () => {
  it("counts from the question to its last answer, over the question's first answer", () => {
    // An agent's answer in steps: code, its result, and the words after.
    const messages = [
      asked(1, "2026-10-08T09:00:00.000Z"),
      answer(2, "2026-10-08T09:00:04.000Z", true),
      result(3, "2026-10-08T09:00:09.000Z"),
      answer(4, "2026-10-08T09:00:21.400Z"),
    ];
    expect([...workedFor(turnsOf(messages))]).toStrictEqual([[2, 21_400]]);
  });

  it("gives every question its own time", () => {
    const messages = [
      asked(1, "2026-10-08T09:00:00.000Z"),
      answer(2, "2026-10-08T09:00:03.000Z"),
      asked(3, "2026-10-08T09:10:00.000Z"),
      answer(4, "2026-10-08T09:14:21.000Z"),
    ];
    expect([...workedFor(turnsOf(messages))]).toStrictEqual([
      [2, 3000],
      [4, 261_000],
    ]);
  });

  it("says nothing for the question Grasp still works on", () => {
    const messages = [
      asked(1, "2026-10-08T09:00:00.000Z"),
      answer(2, "2026-10-08T09:00:03.000Z"),
      asked(3, "2026-10-08T09:10:00.000Z"),
      answer(4, "2026-10-08T09:10:05.000Z", true),
    ];
    const turns = turnsOf(messages);
    expect([...workedFor(turns, turns.at(-1))]).toStrictEqual([[2, 3000]]);
  });

  it("says nothing under a tenth of a second, nor for a question with no answer", () => {
    const messages = [
      asked(1, "2026-10-08T09:00:00.000Z"),
      answer(2, "2026-10-08T09:00:00.040Z"),
      asked(3, "2026-10-08T09:10:00.000Z"),
    ];
    expect(workedFor(turnsOf(messages)).size).toBe(0);
  });

  it("says a time short as #2503 does: tenths under ten seconds, then whole seconds, then minutes", () => {
    expect(
      [800, 5000, 9940, 9960, 14_200, 125_000, 261_000].map(shortTime)
    ).toStrictEqual([
      { minutes: 0, seconds: 0.8, tenths: true },
      { minutes: 0, seconds: 5, tenths: true },
      { minutes: 0, seconds: 9.9, tenths: true },
      { minutes: 0, seconds: 10, tenths: false },
      { minutes: 0, seconds: 14, tenths: false },
      { minutes: 2, seconds: 5, tenths: false },
      { minutes: 4, seconds: 21, tenths: false },
    ]);
  });
});
