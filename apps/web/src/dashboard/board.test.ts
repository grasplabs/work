import { runIdSchema, workflowResourceIdSchema } from "@grasp-os/shared/ids";
import type { WorkflowSummary } from "@grasp-os/shared/workflows";
import { describe, expect, it } from "vite-plus/test";

import { byState, signalKinds, stateOf } from "./board.ts";

// What the dashboard's widget board works out (board.ts): where each
// workflow stands, and the signals by kind.

/** A workflow that ran and needs nobody, changed by `change`. */
const workflow = (
  name: string,
  change: Partial<WorkflowSummary> = {}
): WorkflowSummary => ({
  workflowId: workflowResourceIdSchema.parse(`wf-${name}`),
  name,
  version: 1,
  owner: { userId: "owner", name: null },
  lastRun: {
    id: runIdSchema.parse(`run-${name}`),
    status: "completed",
    createdAt: "2026-10-08T09:00:00.000Z",
  },
  waiting: 0,
  failed: 0,
  handled: 0,
  ...change,
});

const names = (rows: readonly WorkflowSummary[]): string[] =>
  rows.map(({ name }) => name);

describe("where a workflow stands", () => {
  it("needs attention once a run failed lately, even with runs waiting", () => {
    expect(stateOf(workflow("failed", { failed: 1, waiting: 2 }))).toBe(
      "attention"
    );
  });

  it("waits on a person while a run waits, ran once it did, and hasn't run before its first", () => {
    expect(stateOf(workflow("waiting", { waiting: 1 }))).toBe("waiting");
    expect(stateOf(workflow("healthy"))).toBe("ran");
    expect(stateOf(workflow("never", { lastRun: null }))).toBe("notRun");
  });

  it("sorts every workflow into one state, keeping their order", () => {
    const states = byState([
      workflow("a"),
      workflow("b", { waiting: 1 }),
      workflow("c", { lastRun: null }),
      workflow("d"),
      workflow("e", { failed: 3 }),
    ]);
    expect(names(states.attention)).toStrictEqual(["e"]);
    expect(names(states.waiting)).toStrictEqual(["b"]);
    expect(names(states.ran)).toStrictEqual(["a", "d"]);
    expect(names(states.notRun)).toStrictEqual(["c"]);
    expect(byState([]).ran).toStrictEqual([]);
  });
});

describe("the signals by kind", () => {
  it("counts each kind there is, the most first, an unanswered question of either read as one kind", () => {
    expect(
      signalKinds([
        { kind: "correction" },
        { kind: "unanswered_question" },
        { kind: "failing_step" },
        { kind: "unanswered_question" },
        { kind: "overdue_review" },
        { kind: "unanswered_question" },
      ])
    ).toStrictEqual([
      { kind: "unanswered_question", count: 3 },
      { kind: "failing_step", count: 1 },
      { kind: "correction", count: 1 },
      { kind: "overdue_review", count: 1 },
    ]);
    expect(signalKinds([])).toStrictEqual([]);
  });
});
