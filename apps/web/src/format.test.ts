import { describe, expect, it } from "vite-plus/test";

import { formatDaysAgo } from "./format.ts";

// How long ago a day was, by the reader's calendar days, in the page's
// language: what "Updated {when}" says under a project's chats.

const now = new Date(2026, 9, 30, 9, 0);
const daysBack = (days: number, hour = 12): Date =>
  new Date(2026, 9, 30 - days, hour, 0);

describe(formatDaysAgo, () => {
  it("says today, yesterday, days, months and years, by calendar day", () => {
    expect({
      earlierToday: formatDaysAgo(daysBack(0, 1), now, "en"),
      lateYesterday: formatDaysAgo(daysBack(1, 23), now, "en"),
      days: formatDaysAgo(daysBack(4), now, "en"),
      months: formatDaysAgo(daysBack(65), now, "en"),
      years: formatDaysAgo(daysBack(400), now, "en"),
    }).toStrictEqual({
      earlierToday: "today",
      lateYesterday: "yesterday",
      days: "4 days ago",
      months: "2 months ago",
      years: "last year",
    });
  });

  it("says it in the page's language, and a clock ahead of the reader's as today", () => {
    expect({
      dutch: formatDaysAgo(daysBack(1), now, "nl"),
      german: formatDaysAgo(daysBack(4), now, "de"),
      ahead: formatDaysAgo(daysBack(-1), now, "en"),
    }).toStrictEqual({
      dutch: "gisteren",
      german: "vor 4 Tagen",
      ahead: "today",
    });
  });
});
