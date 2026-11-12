import { describe, expect, it } from "vite-plus/test";

import { cronOf, readCron } from "./agent-wakes.tsx";

// The schedule an admin picks in words, as core keeps it. These start
// from the ways it can fail: a time that isn't one sent to core as a
// schedule; a schedule read back as another time than was picked; one
// made elsewhere shown as something it isn't.

describe("a wake-up's schedule, picked in words", () => {
  it("is five cron fields for the rhythm and the time, and none for what isn't a time", () => {
    expect([
      cronOf("weekdays", "09:00"),
      cronOf("daily", "23:05"),
      cronOf("mondays", "07:30"),
    ]).toStrictEqual(["0 9 * * 1-5", "5 23 * * *", "30 7 * * 1"]);
    expect([
      cronOf("daily", ""),
      cronOf("daily", "24:00"),
      cronOf("daily", "9:00"),
    ]).toStrictEqual([undefined, undefined, undefined]);
  });

  it("reads back as the rhythm and time it was made from", () => {
    expect(readCron("0 9 * * 1-5")).toStrictEqual({
      rhythm: "weekdays",
      time: "09:00",
    });
    expect(readCron("5 23 * * *")).toStrictEqual({
      rhythm: "daily",
      time: "23:05",
    });
    expect(readCron("30 7 * * 1")).toStrictEqual({
      rhythm: "mondays",
      time: "07:30",
    });
  });

  it("is no rhythm of ours when it was made another way", () => {
    expect(readCron("0 9 1 * *")).toBeUndefined();
    expect(readCron("0 */2 * * *")).toBeUndefined();
    expect(readCron("0 9 * * 2")).toBeUndefined();
  });
});
