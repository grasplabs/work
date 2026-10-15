import { describe, expect, it } from "vite-plus/test";

import {
  inProgramme,
  nextReport,
  programmeWeek,
  reportWindow,
} from "./programme.ts";

// The programme's weeks (programme.ts): which week today is in, and when
// the next weekly report is ready, from the programme's first Monday.

/** Monday 7 September 2026: the programme's first day. */
const start = "2026-09-07";

describe("the programme's week", () => {
  it("is week 1 from its first Monday through its first Sunday, and week 2 the Monday after", () => {
    expect([
      programmeWeek(start, "2026-09-07"),
      programmeWeek(start, "2026-09-13"),
      programmeWeek(start, "2026-09-14"),
    ]).toStrictEqual([1, 1, 2]);
  });

  it("is week 1 before the programme begins", () => {
    expect(programmeWeek(start, "2026-08-31")).toBe(1);
  });

  it("goes on counting past week 8, which the line no longer counts of 8", () => {
    const last = programmeWeek(start, "2026-11-01");
    const after = programmeWeek(start, "2026-11-02");
    expect({
      last,
      after,
      lastIn: inProgramme(last),
      afterIn: inProgramme(after),
    }).toStrictEqual({ last: 8, after: 9, lastIn: true, afterIn: false });
  });
});

describe("the next weekly report", () => {
  it("is a week away on the first Monday, nothing of the week passed", () => {
    expect(nextReport(start, "2026-09-07")).toStrictEqual({
      inDays: 7,
      week: 1,
      through: 0,
    });
  });

  it("is a day away on the week's Sunday, six of its days passed", () => {
    expect(nextReport(start, "2026-09-13")).toStrictEqual({
      inDays: 1,
      week: 1,
      through: 6,
    });
  });

  it("is ready the day after a week closes, on the week that closed", () => {
    expect(nextReport(start, "2026-09-14")).toStrictEqual({
      inDays: 0,
      week: 1,
      through: 7,
    });
  });

  it("is on the week that runs the day after that", () => {
    expect(nextReport(start, "2026-09-15")).toStrictEqual({
      inDays: 6,
      week: 2,
      through: 1,
    });
  });

  it("counts down to a week after the start before the programme begins", () => {
    expect(nextReport(start, "2026-09-01")).toStrictEqual({
      inDays: 13,
      week: 1,
      through: 0,
    });
  });

  it("is ready on week 8 the Monday after it, and on week 9 after that", () => {
    expect([
      nextReport(start, "2026-11-02"),
      nextReport(start, "2026-11-09"),
    ]).toStrictEqual([
      { inDays: 0, week: 8, through: 7 },
      { inDays: 0, week: 9, through: 7 },
    ]);
  });
});

describe("what a weekly report is about", () => {
  it("is the week that just closed, whole, on the day its report is ready", () => {
    expect(reportWindow(start, "2026-09-14")).toStrictEqual({
      to: "2026-09-13",
      days: 7,
    });
  });

  it("is the week that runs, up to today, until then", () => {
    expect({
      monday: reportWindow(start, "2026-09-07"),
      sunday: reportWindow(start, "2026-09-13"),
      next: reportWindow(start, "2026-09-15"),
    }).toStrictEqual({
      monday: { to: "2026-09-07", days: 1 },
      sunday: { to: "2026-09-13", days: 7 },
      next: { to: "2026-09-15", days: 2 },
    });
  });

  it("is today before the programme begins", () => {
    expect(reportWindow(start, "2026-09-01")).toStrictEqual({
      to: "2026-09-01",
      days: 1,
    });
  });
});
