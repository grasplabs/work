import { describe, expect, it } from "vite-plus/test";

import { isoWeekOf } from "../src/work-knowledge.ts";

// A sentence's week, as the Knowledge tab dates it instead of a day: the
// ISO week, whose Thursday decides the year it counts in.

describe(isoWeekOf, () => {
  it("dates a day by its ISO week", () => {
    expect(isoWeekOf("2026-10-14")).toBe("2026-W42");
    expect(isoWeekOf("2026-10-14T23:59:00Z")).toBe("2026-W42");
  });

  it("counts the days around new year in the year their Thursday is in", () => {
    // Thursday 1 January 2026 begins week 1; Monday 29 December 2025 is in it.
    expect(isoWeekOf("2025-12-29")).toBe("2026-W01");
    // Friday 1 January 2027 is in the last week of 2026.
    expect(isoWeekOf("2027-01-01")).toBe("2026-W53");
  });
});
