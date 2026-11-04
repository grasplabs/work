import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { decisionEventType } from "../src/decisions/decisions.ts";
import { waitKeyOf, waitStep } from "../src/workflows/host.ts";
import { shownWaits, tasksByKey } from "../src/workflows/run-waits.ts";
import type { Pending, WaitContext } from "../src/workflows/run-waits.ts";

// Which of a run's open waits a screen is shown, by the steps an
// independent run's host names (resource-host.ts): names the run's code
// chose are never shown, so nothing it read reaches a screen through one.
// A run on the run host names its steps by its build's table of tasks
// (sealed-steps.ts), read by that table alike.

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

/** A task's own step, in no loop. */
const ownStep = { steps: ["task"], scope: [] };

/** A build of a sleep, a connector call, a decision, a listen and a run. */
const context: WaitContext = {
  tasks: new Map([
    ["hold", { kind: "wait", ...ownStep }],
    ["send", { kind: "call", ...ownStep }],
    ["ask", { kind: "call", decision: "approval", ...ownStep }],
    ["await-job", { kind: "listen", ...ownStep }],
    ["sub", { kind: "run", ...ownStep }],
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
          pendingOf(10, "$grasp:decision:task:ask:woken:0", "retry"),
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
            "$grasp:decision:task:ask:wait:0",
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
            "$grasp:decision:task:ask:wait:0",
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

/**
 * A build generated for the run host: a fixed wait, a deadline's wait, a
 * call its catch retries, a decision, and in loop `rows` a wait and, in
 * loop `cells` inside it, a call.
 */
const sealedContext: WaitContext = {
  ...context,
  sealed: true,
  tasks: new Map([
    ["linger", { kind: "wait", steps: ["task"], scope: [] }],
    ["pause", { kind: "wait", steps: ["enter", "task"], scope: [] }],
    ["fetch", { kind: "call", steps: ["task"], scope: [] }],
    [
      "approve",
      {
        kind: "call",
        decision: "approval",
        steps: ["enter", "task", "leave"],
        scope: [],
      },
    ],
    ["rows", { kind: "for", steps: ["enter", "item"], scope: [] }],
    ["nap", { kind: "wait", steps: ["task"], scope: ["rows"] }],
    ["cells", { kind: "for", steps: ["enter"], scope: ["rows"] }],
    ["send", { kind: "call", steps: ["task"], scope: ["rows", "cells"] }],
  ]),
};

describe("the waits a screen is shown of a run on the run host", () => {
  it("shows a fixed wait's, a deadline's and a loop item's sleep, and a retry of a step in nested items", () => {
    expect(
      shownWaits(
        [
          pendingOf(1, "linger:task"),
          // A deadline's `until` is recorded in its enter step, then slept.
          pendingOf(2, "pause:task"),
          pendingOf(3, "nap:task%403"),
          pendingOf(4, "send:task%402%2F5", "retry"),
          pendingOf(5, "pause:enter", "retry"),
        ],
        sealedContext
      )
    ).toStrictEqual([
      {
        id: "wait-1",
        taskId: "linger",
        key: "linger",
        title: "linger",
        ...times,
        kind: "timer",
        purpose: "sleep",
      },
      {
        id: "wait-2",
        taskId: "pause",
        key: "pause",
        title: "pause",
        ...times,
        kind: "timer",
        purpose: "sleep",
      },
      {
        id: "wait-3",
        taskId: "nap",
        key: "nap",
        title: "nap",
        ...times,
        kind: "timer",
        purpose: "sleep",
      },
      {
        id: "wait-4",
        taskId: "send",
        key: "send",
        title: "send",
        ...times,
        kind: "timer",
        purpose: "retry",
      },
      {
        id: "wait-5",
        taskId: "pause",
        key: "pause",
        title: "pause",
        ...times,
        kind: "timer",
        purpose: "retry",
      },
    ]);
  });

  it("shows a catch's retry backing off, and its round's run again, as retries of the task whose step has the key", async () => {
    const journal = ["linger:task", "fetch:task", "nap:task%403"];
    const keyed = await tasksByKey(journal, sealedContext.tasks);
    const fetch = waitStep(await waitKeyOf("fetch:task"), "retry", 2);
    const nap = waitStep(await waitKeyOf("nap:task%403"), "retry", 1);
    const unknown = waitStep("f".repeat(16), "retry", 2);
    expect(
      shownWaits(
        [
          pendingOf(6, `${fetch}:wait`),
          pendingOf(7, `${nap}:run`, "retry"),
          // Its decision is no wait.
          pendingOf(8, `${fetch}:decide`),
          // A step the journal holds none of: a retry of the run's.
          pendingOf(9, `${unknown}:wait`),
        ],
        { ...sealedContext, keyed }
      )
    ).toStrictEqual([
      {
        id: "wait-6",
        taskId: "fetch",
        key: "fetch",
        title: "fetch",
        ...times,
        kind: "timer",
        purpose: "retry",
      },
      {
        id: "wait-7",
        taskId: "nap",
        key: "nap",
        title: "nap",
        ...times,
        kind: "timer",
        purpose: "retry",
      },
      {
        id: "wait-9",
        taskId: "$run",
        key: "$run",
        title: "Retrying a step",
        ...times,
        kind: "timer",
        purpose: "retry",
      },
    ]);
  });

  it("shows a decision's wait, and its wait again, by the ID its event names, as the key the release sealed", async () => {
    const decision = crypto.randomUUID();
    const answer = "approve:task#answer";
    const keyed = await tasksByKey(
      ["approve:enter", "approve:task", "approve:task#ask", answer],
      sealedContext.tasks
    );
    const again = `$grasp:wait:${await waitKeyOf(answer)}:again:1`;
    const event = decisionEventType(decision);
    const shown = {
      id: decision,
      taskId: "approve",
      key: "approval",
      title: "approve",
      ...times,
      kind: "decision",
      canRespond: false,
    };
    expect({
      sealed: shownWaits(
        [
          pendingOf(10, answer, "waitForEvent", event),
          // A sealed decision has no reminder: never its wait.
          pendingOf(
            11,
            "approve:task#answer-after-reminder",
            "waitForEvent",
            event
          ),
          pendingOf(12, again, "waitForEvent", event),
        ],
        { ...sealedContext, keyed }
      ),
      unsealed: shownWaits([pendingOf(10, answer, "waitForEvent", event)], {
        ...sealedContext,
        decisionKeys: new Set(),
      }),
    }).toStrictEqual({
      sealed: [shown, shown],
      unsealed: [],
    });
  });

  it("shows no step its build's table doesn't have, nor a name of another generator's or another encoding", () => {
    expect(
      shownWaits(
        [
          // Another generator's names, read only for its builds.
          pendingOf(20, "task:linger"),
          pendingOf(21, "task:linger:retry:2:wait"),
          // No such task, or no such step of it.
          pendingOf(22, "ghost:task"),
          pendingOf(23, "linger:enter"),
          // Items of a task in no loop, none of one in a loop, too many.
          pendingOf(24, "linger:task%400"),
          pendingOf(25, "nap:task"),
          pendingOf(26, "nap:task%400%2F1"),
          // An index another way than the SDK encodes it.
          pendingOf(27, "nap:task@3"),
          pendingOf(28, "nap:task%4003"),
          // A sleep of a decision's own step, of a deadline's enter step.
          pendingOf(29, "approve:task#ask"),
          pendingOf(30, "pause:enter"),
        ],
        sealedContext
      )
    ).toStrictEqual([]);
  });

  it("shows a held call's and a busy step's holds, and their runs again, as the task's whose step has the key", async () => {
    const keyed = await tasksByKey(["fetch:task"], sealedContext.tasks);
    const fetch = await waitKeyOf("fetch:task");
    const unknown = "f".repeat(16);
    expect(
      shownWaits(
        [
          pendingOf(40, `${waitStep(fetch, "held", 1)}:0`, "waitForEvent"),
          // The same hold's check: shown once.
          pendingOf(41, `${waitStep(fetch, "held", 1)}:1:check`, "retry"),
          pendingOf(42, `${waitStep(fetch, "held", 1)}:run`, "retry"),
          pendingOf(43, waitStep(unknown, "busy", 1)),
        ],
        { ...sealedContext, keyed }
      ).map((wait) =>
        z
          .object({ id: z.string(), taskId: z.string(), kind: z.string() })
          .parse(wait)
      )
    ).toStrictEqual([
      { id: "hold-40", taskId: "fetch", kind: "blocked" },
      { id: "wait-42", taskId: "fetch", kind: "timer" },
      { id: "hold-43", taskId: "$run", kind: "blocked" },
    ]);
  });
});
