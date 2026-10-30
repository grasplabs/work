import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import type {
  RunActivity,
  RunActivityDay,
  RunActivityWorkflow,
} from "@grasp-os/shared/workflows";
import { describe, expect, it } from "vite-plus/test";

import { runFiguresOf, workflowFiguresOf } from "./run-figures.ts";

// The figures over the runs (run-figures.ts): how many ran, the share
// that needed no person, and how many wait for one, for every workflow
// together and for one.

/** A day of October with no runs, changed by `change`. */
const day = (
  date: number,
  change: Partial<RunActivityDay> = {}
): RunActivityDay => ({
  day: `2026-10-${String(date).padStart(2, "0")}`,
  completed: 0,
  failed: 0,
  waiting: 0,
  other: 0,
  withPerson: 0,
  ...change,
});

/** A workflow of the Invoices App that ran, changed by `change`. */
const ran = (
  name: string,
  change: Partial<RunActivityWorkflow> = {}
): RunActivityWorkflow => ({
  app: appIdSchema.parse("invoices"),
  appName: "Invoices",
  workflow: workflowIdSchema.parse(name),
  current: true,
  started: 0,
  completed: 0,
  failed: 0,
  completedAlone: 0,
  ...change,
});

/** Activity over `days` and `workflows`, its totals the days'. */
const activityOf = (
  days: RunActivityDay[],
  workflows: RunActivityWorkflow[] = []
): RunActivity => {
  const total = days.reduce(
    (sum, each) =>
      sum + each.completed + each.failed + each.waiting + each.other,
    0
  );
  const withPerson = days.reduce((sum, each) => sum + each.withPerson, 0);
  return {
    from: days[0]?.day ?? "",
    to: days.at(-1)?.day ?? "",
    days,
    runs: { total, withPerson, withoutPerson: total - withPerson },
    decisions: { approved: 0, rejected: 0, timedOut: 0, open: 0 },
    workflows,
  };
};

describe("the figures over the runs", () => {
  it("counts every workflow's runs, the share that asked no one, and those waiting", () => {
    expect(
      runFiguresOf(
        activityOf([
          day(1, { completed: 5, failed: 1, withPerson: 2 }),
          day(2, { completed: 1, waiting: 2, other: 1, withPerson: 2 }),
        ])
      )
    ).toStrictEqual({ runs: 10, alone: 0.6, waiting: 2 });
  });

  it("has no share without runs, rather than none of them", () => {
    expect(runFiguresOf(activityOf([day(1), day(2)]))).toStrictEqual({
      runs: 0,
      alone: null,
      waiting: 0,
    });
  });

  it("counts one workflow's runs and the share that completed without a person, with its waiting runs as given", () => {
    const activity = activityOf(
      [day(1, { completed: 4 })],
      [
        ran("approve", { started: 8, completed: 6, completedAlone: 2 }),
        ran("remind", { started: 4, completed: 4, completedAlone: 4 }),
      ]
    );
    expect(
      workflowFiguresOf(activity, { app: "invoices", workflow: "approve" }, 3)
    ).toStrictEqual({ runs: 8, alone: 0.25, waiting: 3 });
  });

  it("has no runs and no share for a workflow that didn't run in the window", () => {
    expect(
      workflowFiguresOf(
        activityOf([day(1)], [ran("approve", { started: 2 })]),
        { app: "other", workflow: "approve" },
        1
      )
    ).toStrictEqual({ runs: 0, alone: null, waiting: 1 });
  });
});
