import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { decisionEventType } from "../src/decisions/decisions.ts";
import { waitKeyOf, waitStep } from "../src/workflows/host.ts";
import { shownWaits, tasksByKey } from "../src/workflows/run-waits.ts";
import type { Pending, WaitContext } from "../src/workflows/run-waits.ts";

// Which of a run's open waits a page is shown, by the steps its build's
// table of tasks names (sealed-steps.ts): names the run's code chose are
// never shown, so nothing it read reaches a page through one.

const openedAt = 1000;
const deadline = 61_000;

const pendingOf = (
  ordinal: number,
  name: string,
  type: Pending["type"] = "sleep",
  eventType: string | null = null
): Pending => ({ ordinal, type, name, eventType, openedAt, deadline });

/** A task's own step, in no loop. */
const ownStep = { steps: ["task"], scope: [] };

/** A build of a sleep, a connector call, a decision and a listen. */
const context: WaitContext = {
  tasks: new Map([
    ["hold", { kind: "wait", ...ownStep }],
    ["send", { kind: "call", ...ownStep }],
    ["ask", { kind: "call", decision: "approval", ...ownStep }],
    ["awaitJob", { kind: "listen", ...ownStep }],
  ]),
  decisionKeys: new Set(["approval"]),
  listens: { awaitJob: ["jobEvents"] },
  events: new Map([["jobEvents", "f".repeat(64)]]),
  canSend: true,
};

const times = { openedAt, deadline };

/**
 * A build generated for the run host: a fixed wait, a deadline's wait (a
 * `grasp.sleepUntil` call), a call its catch retries, a decision, and in
 * loop `rows` a wait and, in loop `cells` inside it, a call. A loop has no
 * steps of its own: its flow is the code's.
 */
const sealedContext: WaitContext = {
  ...context,
  tasks: new Map([
    ["linger", { kind: "wait", steps: ["task"], scope: [] }],
    ["pause", { kind: "call", steps: ["enter", "task"], scope: [] }],
    ["fetch", { kind: "call", steps: ["task"], scope: [] }],
    [
      "approve",
      {
        kind: "call",
        decision: "approval",
        steps: ["enter", "task"],
        scope: [],
      },
    ],
    ["rows", { kind: "for", steps: [], scope: [] }],
    ["nap", { kind: "wait", steps: ["task"], scope: ["rows"] }],
    ["cells", { kind: "for", steps: [], scope: ["rows"] }],
    ["send", { kind: "call", steps: ["task"], scope: ["rows", "cells"] }],
  ]),
};

describe("the waits a page is shown of a run on the run host", () => {
  it("shows a fixed wait's, a deadline's and a loop item's sleep, and a retry of a step in nested items", () => {
    expect(
      shownWaits(
        [
          pendingOf(1, "linger:task"),
          // A deadline's `until` is recorded in its enter step, then slept.
          pendingOf(2, "pause:task"),
          // A task's run in a loop's items again, by its count of runs.
          pendingOf(3, "nap:task@3"),
          pendingOf(4, "send:task@5", "retry"),
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
    const journal = ["linger:task", "fetch:task", "nap:task@3"];
    const keyed = await tasksByKey(journal, sealedContext.tasks);
    const fetch = waitStep(await waitKeyOf("fetch:task"), "retry", 2);
    const nap = waitStep(await waitKeyOf("nap:task@3"), "retry", 1);
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
      [
        "approve:enter",
        "approve:task",
        "approve:task#ask",
        "approve:task#asked",
        answer,
      ],
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

  it("shows no step its build's table doesn't have, nor a name of another encoding", () => {
    expect(
      shownWaits(
        [
          // Names the run host never gives a step.
          pendingOf(20, "task:linger"),
          pendingOf(21, "task:linger:retry:2:wait"),
          // No such task, or no such step of it: a loop has none.
          pendingOf(22, "ghost:task"),
          pendingOf(23, "linger:enter"),
          pendingOf(24, "rows:enter"),
          // A run again of a task in no loop.
          pendingOf(25, "linger:task@1"),
          // A count another way than the journal writes it: a first
          // run's, a loop's indexes, escaped, padded.
          pendingOf(26, "nap:task@0"),
          pendingOf(27, "send:task@1/0"),
          pendingOf(28, "nap:task%403"),
          pendingOf(29, "nap:task@03"),
          // A sleep of a decision's own step, of a deadline's enter step.
          pendingOf(30, "approve:task#ask"),
          pendingOf(31, "pause:enter"),
        ],
        sealedContext
      )
    ).toStrictEqual([]);
  });

  it("shows a held call's and a busy step's holds, and their runs again, as the task's whose step has the key", async () => {
    const fetch = await waitKeyOf("fetch:task");
    // Its catch's retry's run again, whose own holds go by its own key.
    const again = `${waitStep(fetch, "retry", 2)}:run`;
    const keyed = await tasksByKey(["fetch:task", again], sealedContext.tasks);
    const retried = await waitKeyOf(again);
    const unknown = "f".repeat(16);
    expect(
      shownWaits(
        [
          pendingOf(40, `${waitStep(fetch, "held", 1)}:0`, "waitForEvent"),
          // The same hold's check: shown once.
          pendingOf(41, `${waitStep(fetch, "held", 1)}:1:check`, "retry"),
          pendingOf(42, `${waitStep(fetch, "held", 1)}:run`, "retry"),
          pendingOf(43, waitStep(unknown, "busy", 1)),
          pendingOf(
            44,
            `${waitStep(retried, "unknown", 1)}:first`,
            "waitForEvent"
          ),
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
      { id: "hold-44", taskId: "fetch", kind: "blocked" },
    ]);
  });
});
