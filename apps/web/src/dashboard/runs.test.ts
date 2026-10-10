import type { RunActivity, RunActivityDay } from "@grasp-os/shared/workflows";
import { describe, expect, it } from "vite-plus/test";

import {
  columnsOf,
  isLabelled,
  lastDays,
  runsOn,
  withoutPerson,
} from "./runs.ts";

// What the dashboard's Runs widget works out (runs.ts): the last days,
// each day as a column of how its runs stand, and how many runs needed
// nobody.

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

/** Activity over `days`, its other counts empty. */
const activityOf = (days: RunActivityDay[]): RunActivity => ({
  from: days[0]?.day ?? "",
  to: days.at(-1)?.day ?? "",
  days,
  runs: { total: 0, withPerson: 0, withoutPerson: 0 },
  decisions: { approved: 0, rejected: 0, timedOut: 0, open: 0 },
  workflows: [],
});

describe("the Runs widget", () => {
  it("counts a day's runs of every outcome", () => {
    expect(
      runsOn(day(1, { completed: 3, failed: 1, waiting: 2, other: 1 }))
    ).toBe(7);
  });

  it("takes the last days, oldest first", () => {
    const month = Array.from({ length: 10 }, (_, index) => day(index + 1));
    expect(
      lastDays(activityOf(month), 3).map((entry) => entry.day)
    ).toStrictEqual(["2026-10-08", "2026-10-09", "2026-10-10"]);
  });

  it("stacks each day's outcomes from the ground up, on the scale of the busiest day", () => {
    const columns = columnsOf([
      day(1, { completed: 2, failed: 1, waiting: 1 }),
      day(2),
      day(3, { completed: 1, other: 1 }),
    ]);
    expect(
      columns.map(({ runs, parts }) => ({
        runs,
        parts: parts.map(({ outcome, height, from }) => [
          outcome,
          height,
          from,
        ]),
      }))
    ).toStrictEqual([
      {
        runs: 4,
        parts: [
          ["completed", 0.5, 0],
          ["failed", 0.25, 0.5],
          ["waiting", 0.25, 0.75],
        ],
      },
      { runs: 0, parts: [] },
      {
        runs: 2,
        parts: [
          ["completed", 0.25, 0],
          ["other", 0.25, 0.25],
        ],
      },
    ]);
  });

  it("says how many runs needed nobody, and has no share without runs", () => {
    expect(
      withoutPerson([
        day(1, { completed: 3, withPerson: 1 }),
        day(2, { failed: 1 }),
      ])
    ).toStrictEqual({ runs: 4, without: 3, share: 0.75 });
    expect(withoutPerson([day(1), day(2)])).toStrictEqual({
      runs: 0,
      without: 0,
      share: null,
    });
  });

  it("names every day of a week, and every fifth of a month counted back from today", () => {
    expect(
      Array.from({ length: 7 }, (_, index) => isLabelled(index, 7))
    ).toStrictEqual(Array.from({ length: 7 }, () => true));
    const month = Array.from({ length: 30 }, (_, index) => index).filter(
      (index) => isLabelled(index, 30)
    );
    expect(month).toStrictEqual([4, 9, 14, 19, 24, 29]);
  });
});
