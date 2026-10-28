import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { decisionEventType } from "../src/decisions/decisions.ts";
import { shownWaits } from "../src/workflows/run-waits.ts";
import type { Pending, WaitContext } from "../src/workflows/run-waits.ts";

// Which of a run's open waits a screen is shown, by the steps an
// independent run's host names (resource-host.ts): names the run's code
// chose are never shown, so nothing it read reaches a screen through one.

const key = "0123456789abcdef";
const openedAt = 1000;
const deadline = 61_000;

const pendingOf = (
  ordinal: number,
  name: string,
  type: Pending["type"] = "sleep",
  eventType: string | null = null
): Pending => ({ ordinal, type, name, eventType, openedAt, deadline });

const child = {
  runId: "child-run",
  workflowId: "child-workflow",
  workflowVersion: 1,
  manifestHash: "m",
};

/** A build of a sleep, a connector call, a decision, a listen and a run. */
const context: WaitContext = {
  tasks: new Map([
    ["hold", { kind: "wait" }],
    ["send", { kind: "call" }],
    ["ask", { kind: "call", decision: "approval" }],
    ["await-job", { kind: "listen" }],
    ["sub", { kind: "run" }],
  ]),
  decisionKeys: new Set(["approval"]),
  listens: { "await-job": ["jobEvents"] },
  events: new Map([["jobEvents", "f".repeat(64)]]),
  child,
  canSend: true,
};

const times = { openedAt, deadline };

describe("the waits a screen is shown of a run", () => {
  it("shows a declared task's sleep and leaves out an undeclared task and a step named by the run's code", () => {
    expect(
      shownWaits(
        [
          pendingOf(1, "task:hold"),
          pendingOf(2, "task:undeclared"),
          pendingOf(3, "ada@example.com"),
          pendingOf(4, "invoice 4711 for Acme", "retry"),
        ],
        context
      )
    ).toStrictEqual([
      {
        id: "wait-1",
        taskId: "hold",
        key: "hold",
        title: "hold",
        ...times,
        kind: "timer",
        purpose: "sleep",
      },
    ]);
  });

  it("shows a connector call held for its person once a round, its checks too, and its run again as a retry", () => {
    expect(
      shownWaits(
        [
          pendingOf(5, "task:send:held:1:0", "waitForEvent", "held-wake"),
          pendingOf(6, "task:send:held:1:1:check", "retry"),
          pendingOf(7, "task:send@0:held:2:0:check", "retry"),
          pendingOf(8, "task:send:held:2:run", "retry"),
        ],
        context
      )
    ).toStrictEqual([
      {
        id: "hold-5",
        taskId: "send",
        key: "send",
        title: "Waiting for confirmation",
        ...times,
        kind: "blocked",
        reason: "policy",
        message:
          "A call of this run waits for the person it acts for to confirm it.",
      },
      {
        id: "hold-7",
        taskId: "send",
        key: "send",
        title: "Waiting for confirmation",
        ...times,
        kind: "blocked",
        reason: "policy",
        message:
          "A call of this run waits for the person it acts for to confirm it.",
      },
      {
        id: "wait-8",
        taskId: "send",
        key: "send",
        title: "send",
        ...times,
        kind: "timer",
        purpose: "retry",
      },
    ]);
  });

  it("shows a task's retry, a decision's look's retry and a step waiting for load, each once", () => {
    expect(
      shownWaits(
        [
          pendingOf(9, "task:send", "retry"),
          pendingOf(10, "task:ask:decision:woken:0", "retry"),
          pendingOf(11, `$grasp:wait:${key}:busy:1`),
          pendingOf(12, `$grasp:wait:${key}:busy:1:run`, "retry"),
        ],
        context
      ).map((wait) =>
        z.object({ id: z.string(), kind: z.string() }).parse(wait)
      )
    ).toStrictEqual([
      { id: "wait-9", kind: "timer" },
      { id: "wait-10", kind: "timer" },
      { id: "hold-11", kind: "blocked" },
      { id: "wait-12", kind: "timer" },
    ]);
  });

  it("shows a retried round's held call as a first round's, once each round, and its run again as a retry", () => {
    expect(
      shownWaits(
        [
          pendingOf(
            20,
            "task:send:retry:2:held:1:0",
            "waitForEvent",
            "held-wake"
          ),
          pendingOf(21, "task:send:retry:2:held:1:1:check", "retry"),
          // Another round's hold is a hold of its own.
          pendingOf(
            22,
            "task:send:retry:3:held:1:0",
            "waitForEvent",
            "held-wake"
          ),
          pendingOf(23, "task:send:retry:2:held:1:run", "retry"),
          // A step of the run's code under a retry's name: never shown.
          pendingOf(
            24,
            "task:send:retry:2:held:x",
            "waitForEvent",
            "held-wake"
          ),
        ],
        context
      ).map((wait) =>
        z.object({ id: z.string(), kind: z.string() }).loose().parse(wait)
      )
    ).toMatchObject([
      { id: "hold-20", kind: "blocked", reason: "policy" },
      { id: "hold-22", kind: "blocked", reason: "policy" },
      { id: "wait-23", kind: "timer", purpose: "retry" },
    ]);
  });

  it("shows a try's backoff before a step runs again, and that round's own retry, as retries, a loop item's too", () => {
    expect(
      shownWaits(
        [
          pendingOf(13, "task:hold:retry:2:wait"),
          pendingOf(14, "task:hold@0/1:retry:3:wait"),
          pendingOf(15, "task:send:retry:2", "retry"),
          // A sleep of the run's code under a task's name: never shown.
          pendingOf(16, "task:hold:retry:2:nap"),
        ],
        context
      ).map((wait) =>
        z
          .object({ id: z.string(), kind: z.string(), purpose: z.string() })
          .parse(wait)
      )
    ).toStrictEqual([
      { id: "wait-13", kind: "timer", purpose: "retry" },
      { id: "wait-14", kind: "timer", purpose: "retry" },
      { id: "wait-15", kind: "timer", purpose: "retry" },
    ]);
  });

  it("shows a decision by the ID its event names, as the key the release sealed, and none of a key it didn't", () => {
    const decision = crypto.randomUUID();
    expect({
      sealed: shownWaits(
        [
          pendingOf(
            13,
            "task:ask:decision:wait:0",
            "waitForEvent",
            decisionEventType(decision)
          ),
        ],
        context
      ),
      unsealed: shownWaits(
        [
          pendingOf(
            13,
            "task:ask:decision:wait:0",
            "waitForEvent",
            decisionEventType(decision)
          ),
        ],
        { ...context, decisionKeys: new Set() }
      ),
    }).toStrictEqual({
      sealed: [
        {
          id: decision,
          taskId: "ask",
          key: "approval",
          title: "ask",
          ...times,
          kind: "decision",
          canRespond: false,
        },
      ],
      unsealed: [],
    });
  });

  it("shows a listen task's events of the release's reference, and a run task's one child", () => {
    expect(
      shownWaits(
        [
          pendingOf(14, "task:await-job", "waitForEvent"),
          pendingOf(15, "task:sub", "waitForEvent"),
        ],
        context
      )
    ).toStrictEqual([
      {
        id: "wait-14-0",
        taskId: "await-job",
        key: "await-job",
        title: "await-job",
        ...times,
        kind: "event",
        event: {
          kind: "workflowEvent",
          alias: "jobEvents",
          fingerprint: "f".repeat(64),
        },
        canSend: true,
      },
      {
        id: "wait-15",
        taskId: "sub",
        key: "sub",
        title: "sub",
        ...times,
        kind: "child",
        child,
      },
    ]);
  });

  it("shows no event a screen doesn't send, and no child it can't tell apart", () => {
    expect(
      shownWaits(
        [
          pendingOf(16, "task:await-job", "waitForEvent"),
          pendingOf(17, "task:sub", "waitForEvent"),
        ],
        { ...context, listens: {}, child: undefined }
      )
    ).toStrictEqual([]);
  });
});
