import { describe, expect, it } from "vite-plus/test";

import { addDays, addMonths } from "../../src/admin/admin-account.ts";

describe("days", () => {
  it("count on by the calendar, across months and years", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("a month on is the same day, or the last day the month has", () => {
    expect(addMonths("2026-10-01", 1)).toBe("2026-11-01");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2027-09-30", -3)).toBe("2027-06-30");
    expect(addMonths("2026-11-15", 2)).toBe("2027-01-15");
  });
});
