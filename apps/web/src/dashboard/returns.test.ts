import type { Goal } from "@grasp-os/shared/brain";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import type { WorkflowSummary } from "@grasp-os/shared/workflows";
import { describe, expect, it } from "vite-plus/test";

import { goalProgressOf } from "./returns.ts";

// The board's goals as the goals widget draws them (returns.ts): each by
// its newest wording, with the workflows linked to it and how far each is.

/** A workflow of the invoices App that handled `handled` items this week. */
const workflow = (name: string, handled: number): WorkflowSummary => ({
  app: appIdSchema.parse("invoices"),
  appName: "Invoices",
  workflow: workflowIdSchema.parse(name),
  version: 1,
  owner: { userId: "owner", name: null },
  changesOwner: false,
  lastRun: {
    id: runIdSchema.parse(`run-${name}`),
    status: "completed",
    createdAt: "2026-10-27T09:00:00.000Z",
  },
  waiting: 0,
  failed: 0,
  handled,
  scheduleStopped: false,
});

const goal: Goal = {
  id: "goal-close",
  versions: [
    {
      title: "Close the books in three days",
      howWeNotice: "",
      sourceId: "src-board",
      date: "2026-10-01",
    },
    {
      title: "Close the books in two days",
      howWeNotice: "",
      sourceId: "src-board",
      date: "2026-10-15",
    },
  ],
  workflows: [
    { app: "invoices", workflow: "chase" },
    { app: "invoices", workflow: "remind" },
    // Linked, but not among the workflows the person reads: left out.
    { app: "invoices", workflow: "archive" },
  ],
};

describe("the board's goals", () => {
  it("are each their newest wording, with the workflows linked to them: live once they handle items, else in their test", () => {
    const [progress] = goalProgressOf(
      [goal],
      [workflow("chase", 12), workflow("remind", 0), workflow("other", 3)]
    );
    expect({
      title: progress?.title,
      rows: progress?.rows.map(({ workflow: { name, goalId }, stage }) => [
        name,
        goalId,
        stage,
      ]),
      live: progress?.live,
      // No hours are kept: no return.
      back: progress?.back,
      coming: progress?.coming,
      basis: progress?.rows.map(({ basis }) => basis),
    }).toStrictEqual({
      title: "Close the books in two days",
      rows: [
        ["chase", "goal-close", "live"],
        ["remind", "goal-close", "testing"],
      ],
      live: 1,
      back: 0,
      coming: 0,
      basis: ["unknown", "unknown"],
    });
  });
});
