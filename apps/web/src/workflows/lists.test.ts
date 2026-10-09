import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import type { WorkflowSummary } from "@grasp-os/shared/workflows";
import { describe, expect, it } from "vite-plus/test";

import { listsOf, needsAttention } from "./lists.ts";

/** A workflow that ran and needs nobody, changed by `change`. */
const workflow = (
  name: string,
  change: Partial<WorkflowSummary> = {}
): WorkflowSummary => ({
  app: appIdSchema.parse("invoices"),
  appName: "Invoices",
  workflow: workflowIdSchema.parse(name),
  version: 1,
  owner: { userId: "owner", name: null },
  lastRun: {
    id: runIdSchema.parse(`run-${name}`),
    status: "completed",
    createdAt: "2026-10-08T09:00:00.000Z",
  },
  waiting: 0,
  failed: 0,
  scheduleStopped: false,
  ...change,
});

const healthy = workflow("healthy");
const waiting = workflow("waiting", { waiting: 1 });
const failed = workflow("failed", { failed: 2 });
const stopped = workflow("stopped", { scheduleStopped: true });
const never = workflow("never", { lastRun: null });

const names = (rows: readonly WorkflowSummary[]): string[] =>
  rows.map(({ workflow: name }) => name);

describe("the Workflows page's lists", () => {
  it("needs a person for a run waiting, a recent failure or a stopped schedule, and not otherwise", () => {
    expect(
      [healthy, waiting, failed, stopped, never].map(needsAttention)
    ).toStrictEqual([false, true, true, true, false]);
  });

  it("has those that ran at work, the ones that need a person first, and the rest on the way", () => {
    const { atWork, onTheWay } = listsOf([
      healthy,
      never,
      waiting,
      failed,
      stopped,
    ]);
    expect({
      atWork: names(atWork),
      onTheWay: names(onTheWay),
    }).toStrictEqual({
      atWork: ["waiting", "failed", "stopped", "healthy"],
      onTheWay: ["never"],
    });
  });

  it("puts nothing in a list it doesn't belong to", () => {
    expect(listsOf([never])).toStrictEqual({ atWork: [], onTheWay: [never] });
  });
});
