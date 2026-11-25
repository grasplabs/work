import { describe, expect, it } from "vite-plus/test";

import { weekOf } from "./schedule-read.ts";

const week = (days: string) =>
  Array.from({ length: 7 }, (_, index) => days.includes(String(index)));

describe("a schedule's week", () => {
  it("reads the days and the time of the schedules the agent pages make", () => {
    expect([
      weekOf("0 9 * * 1-5"),
      weekOf("30 8 * * *"),
      weekOf("5 7 * * 1"),
    ]).toStrictEqual([
      { days: week("01234"), hour: 9, minute: 0 },
      { days: week("0123456"), hour: 8, minute: 30 },
      { days: week("0"), hour: 7, minute: 5 },
    ]);
  });

  it("counts Sunday as cron's 0 and 7 alike, at the week's end", () => {
    expect([
      weekOf("0 9 * * 0")?.days,
      weekOf("0 9 * * 6-7")?.days,
    ]).toStrictEqual([week("6"), week("56")]);
  });

  it("reads lists of days and ranges together", () => {
    expect(weekOf("0 9 * * 1,3,5-6")?.days).toStrictEqual(week("0245"));
  });

  it("leaves any other schedule to be shown as its words", () => {
    expect(
      [
        "0 * * * *",
        "*/15 9 * * 1-5",
        "0 9 1 * *",
        "0 9 * 1 *",
        "0 9 * * 5-1",
        "0 9 * * MON",
        "0 24 * * *",
        "0 9 * * 1 extra",
      ].filter((cron) => weekOf(cron) !== undefined)
    ).toStrictEqual([]);
  });
});
