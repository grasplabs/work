import type {
  RunActivity,
  RunActivityDay,
  RunActivityWorkflow,
} from "@grasp-os/shared/workflows";
import { describe, expect, it } from "vite-plus/test";

import { runFiguresOf } from "./run-figures.ts";

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

  it("takes the share that asked no one as core counted it, like the totals beside it", () => {
    const activity = {
      ...activityOf([day(1, { completed: 10, withPerson: 5 })]),
      // Core's own count of the window's runs, which the days only chart.
      runs: { total: 10, withPerson: 3, withoutPerson: 7 },
    };
    expect(runFiguresOf(activity).alone).toBe(0.7);
  });

  it("has no share without runs, rather than none of them", () => {
    expect(runFiguresOf(activityOf([day(1), day(2)]))).toStrictEqual({
      runs: 0,
      alone: null,
      waiting: 0,
    });
  });
});
