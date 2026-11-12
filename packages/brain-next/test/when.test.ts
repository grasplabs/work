// The dates a memory names, resolved in code against the day the words
// were said (when.ts): pure calendar arithmetic, so tested on its own.
import { describe, expect, it } from "vite-plus/test";

import { dayOf, endOfDay, resolveWhen } from "../src/when.ts";
import type { When } from "../src/when.ts";

/** `when` resolved for words said at `at` in Amsterdam. */
const resolvedAt = (at: string, when: When) =>
  resolveWhen(when, dayOf(new Date(at), "Europe/Amsterdam"));

describe("dates a memory names", () => {
  it("counts a weekday from the day the words were said, in the company's time zone", () => {
    expect({
      // Wednesday 11 November 2026: that week's Friday, and the next.
      thisFriday: resolvedAt("2026-11-11T10:00:00Z", {
        kind: "weekday",
        weekday: 5,
        weeksAhead: 0,
      }),
      fridayAfter: resolvedAt("2026-11-11T10:00:00Z", {
        kind: "weekday",
        weekday: 5,
        weeksAhead: 1,
      }),
      // Said on a Friday: "Friday" is the one a week on, never the same day.
      onFriday: resolvedAt("2026-11-13T10:00:00Z", {
        kind: "weekday",
        weekday: 5,
        weeksAhead: 0,
      }),
      // 23:30 UTC on Thursday is already Friday in Amsterdam.
      lateThursday: resolvedAt("2026-11-12T23:30:00Z", {
        kind: "offset",
        days: 1,
      }),
    }).toStrictEqual({
      thisFriday: { date: "2026-11-13" },
      fridayAfter: { date: "2026-11-20" },
      onFriday: { date: "2026-11-20" },
      lateThursday: { date: "2026-11-14" },
    });
  });

  it("adds months by the calendar, keeps written dates, and leaves what it can't hold as said", () => {
    expect({
      monthAfterJanuary31: resolvedAt("2026-01-31T09:00:00Z", {
        kind: "offset",
        months: 1,
      }),
      inTwoWeeks: resolvedAt("2026-12-24T09:00:00Z", {
        kind: "offset",
        weeks: 2,
      }),
      lastYear: resolvedAt("2024-02-29T09:00:00Z", {
        kind: "offset",
        years: -1,
      }),
      written: resolvedAt("2026-11-11T09:00:00Z", {
        kind: "date",
        date: "2027-03-01",
      }),
      phrase: resolvedAt("2026-11-11T09:00:00Z", {
        kind: "phrase",
        phrase: "end of the quarter",
      }),
    }).toStrictEqual({
      monthAfterJanuary31: { date: "2026-02-28" },
      inTwoWeeks: { date: "2027-01-07" },
      lastYear: { date: "2023-02-28" },
      written: { date: "2027-03-01" },
      phrase: { phrase: "end of the quarter" },
    });
  });

  it("ends a day at the next midnight in the company's time zone, across a change of the clocks", () => {
    expect({
      winter: endOfDay("2026-11-13", "Europe/Amsterdam").toISOString(),
      // The clocks go back in the night of 24 to 25 October 2026.
      clocksBack: endOfDay("2026-10-24", "Europe/Amsterdam").toISOString(),
    }).toStrictEqual({
      winter: "2026-11-13T23:00:00.000Z",
      clocksBack: "2026-10-24T22:00:00.000Z",
    });
  });
});
