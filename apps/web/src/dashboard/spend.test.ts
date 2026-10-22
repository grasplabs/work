import { describe, expect, it } from "vite-plus/test";

import { costPerRun } from "./spend.ts";

// What one run of a workflow cost this month (spend.ts).

describe("what one run cost", () => {
  it("is the month's spend over the runs it started", () => {
    expect(costPerRun({ amount: 1.5, runs: 3 })).toBe(0.5);
  });

  it("is none while it started no run this month", () => {
    expect(costPerRun({ amount: 0.2, runs: 0 })).toBeNull();
  });
});
