import { describe, expect, it } from "vite-plus/test";

import { monthEnd, shareOf } from "./money.ts";

describe("this month's spend", () => {
  it("ends where the days so far lead, in this month only", () => {
    expect([
      // 10 days into October's 31, $20 so far.
      monthEnd(20, "2026-10", new Date("2026-10-10T12:00:00Z")),
      // February of a leap year has 29 days.
      monthEnd(10, "2028-02", new Date("2028-02-01T00:00:00Z")),
      // Core counts in a month that isn't this one: no guess.
      monthEnd(20, "2026-09", new Date("2026-10-01T00:00:00Z")),
    ]).toStrictEqual([62, 290, null]);
  });

  it("is a share of its budget, all of a budget of nothing", () => {
    expect([shareOf(5, 20), shareOf(0, 20), shareOf(1, 0)]).toStrictEqual([
      25, 0, 100,
    ]);
  });
});
