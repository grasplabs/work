import type { ChatMessage } from "@grasp-os/shared/chat";
import { describe, expect, it } from "vite-plus/test";

import { minutesAndSeconds, turnsOf, workedFor } from "./turns.ts";

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
    expect([...workedFor(turnsOf(messages))]).toStrictEqual([[2, 21]]);
  });

  it("gives every question its own time", () => {
    const messages = [
      asked(1, "2026-10-08T09:00:00.000Z"),
      answer(2, "2026-10-08T09:00:03.000Z"),
      asked(3, "2026-10-08T09:10:00.000Z"),
      answer(4, "2026-10-08T09:14:21.000Z"),
    ];
    expect([...workedFor(turnsOf(messages))]).toStrictEqual([
      [2, 3],
      [4, 261],
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
    expect([...workedFor(turns, turns.at(-1))]).toStrictEqual([[2, 3]]);
  });

  it("says nothing under a second, nor for a question with no answer", () => {
    const messages = [
      asked(1, "2026-10-08T09:00:00.000Z"),
      answer(2, "2026-10-08T09:00:00.400Z"),
      asked(3, "2026-10-08T09:10:00.000Z"),
    ];
    expect(workedFor(turnsOf(messages)).size).toBe(0);
  });

  it("rounds to whole seconds", () => {
    const messages = [
      asked(1, "2026-10-08T09:00:00.000Z"),
      answer(2, "2026-10-08T09:00:00.600Z"),
    ];
    expect([...workedFor(turnsOf(messages))]).toStrictEqual([[2, 1]]);
  });

  it("says a time short, in minutes and the seconds over them", () => {
    expect(minutesAndSeconds(21)).toStrictEqual({ minutes: 0, rest: 21 });
    expect(minutesAndSeconds(261)).toStrictEqual({ minutes: 4, rest: 21 });
  });
});
