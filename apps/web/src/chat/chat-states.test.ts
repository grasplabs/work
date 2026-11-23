import { describe, expect, it } from "vite-plus/test";

import {
  answerStatusOf,
  chainStatuses,
  stepStatusOf,
  toolStates,
} from "./chat-states.ts";
import type { AnswerProgress } from "./chat-states.ts";

// What the chat's stream reports, in the words Damsko's chat parts take
// (chat-states.ts).

const answer = (progress: Partial<AnswerProgress>): AnswerProgress => ({
  live: false,
  shows: false,
  end: undefined,
  providerMissing: false,
  ...progress,
});

describe("an answer's status", () => {
  it("thinks until something shows, then streams", () => {
    expect(answerStatusOf(answer({ live: true }))).toBe("thinking");
    expect(answerStatusOf(answer({ live: true, shows: true }))).toBe(
      "streaming"
    );
  });

  it("is done once answered, and when cut off at the model's limit", () => {
    expect(answerStatusOf(answer({ end: "done" }))).toBe("done");
    expect(answerStatusOf(answer({ end: "cut_off" }))).toBe("done");
  });

  it("is stopped when the person stopped it, and failed when the model did", () => {
    expect(answerStatusOf(answer({ end: "cancelled" }))).toBe("stopped");
    expect(answerStatusOf(answer({ end: "failed" }))).toBe("error");
  });

  it("is no error when no AI provider is connected yet", () => {
    expect(
      answerStatusOf(answer({ end: "failed", providerMissing: true }))
    ).toBe("done");
  });
});

describe("a step's status", () => {
  const result = { failed: false };
  const failed = { failed: true };

  it("is written, then runs, until its result comes", () => {
    expect(
      stepStatusOf({
        result: undefined,
        writing: true,
        running: true,
        recovered: false,
      })
    ).toBe("writing");
    expect(
      stepStatusOf({
        result: undefined,
        writing: false,
        running: true,
        recovered: false,
      })
    ).toBe("running");
  });

  it("is done, failed, or retried when a later step recovered", () => {
    expect(
      stepStatusOf({ result, writing: false, running: true, recovered: false })
    ).toBe("done");
    expect(
      stepStatusOf({
        result: failed,
        writing: false,
        running: false,
        recovered: false,
      })
    ).toBe("failed");
    expect(
      stepStatusOf({
        result: failed,
        writing: false,
        running: false,
        recovered: true,
      })
    ).toBe("retried");
  });

  it("is stopped when the agent stopped before its result came", () => {
    expect(
      stepStatusOf({
        result: undefined,
        writing: false,
        running: false,
        recovered: false,
      })
    ).toBe("stopped");
  });

  it("reads as a Tool's state and a step of a chain of thought", () => {
    expect({ tool: toolStates, chain: chainStatuses }).toStrictEqual({
      tool: {
        writing: "input-streaming",
        running: "input-available",
        done: "output-available",
        retried: "output-available",
        failed: "output-error",
        stopped: "output-error",
      },
      chain: {
        writing: "active",
        running: "active",
        done: "complete",
        retried: "complete",
        failed: "error",
        stopped: "pending",
      },
    });
  });
});
