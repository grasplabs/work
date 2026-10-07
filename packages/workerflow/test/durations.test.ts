// The duration forms a sleep and an event wait take: pure parsing.
import { describe, expect, it } from "vite-plus/test";

import { maxWaitMs, parseDuration } from "../src/durations.ts";

describe("a duration", () => {
  it.each([
    [0, 0],
    [1500, 1500],
    // Never earlier than asked.
    [0.2, 1],
    ["1 second", 1000],
    ["10 seconds", 10_000],
    ["1.5 hours", 5_400_000],
    ["1 day", 86_400_000],
    ["2 weeks", 1_209_600_000],
    // The reference's units: a month is 30 days, a year 365.25 days.
    ["1 month", 2_592_000_000],
    ["365 days", maxWaitMs],
  ])("reads %j as %i milliseconds", (duration, ms) => {
    expect(parseDuration(duration, "it")).toBe(ms);
  });

  it.each([
    "10 secs",
    "10seconds",
    "10  seconds",
    " 10 seconds",
    "1000",
    "-1 second",
    "1 year",
    "",
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    maxWaitMs + 1,
    null,
    { seconds: 1 },
  ])("refuses %j", (duration) => {
    expect(() => parseDuration(duration, "it")).toThrow(TypeError);
  });
});
