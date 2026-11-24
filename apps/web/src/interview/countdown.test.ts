import type { InterviewProgress } from "@grasp-os/shared/interview-links";
import { describe, expect, it } from "vite-plus/test";

import { secondsLeft } from "./countdown.tsx";
import { freshProgress } from "./progress.ts";
import { remindTimes } from "./start.tsx";

// The countdown counts the minutes Stephen is told, never the time someone
// was away: back the next day, it stands where they stopped.

const minute = 60_000;
const start = Date.UTC(2026, 10, 24, 9, 0);

/** An interview started at `start`, its last turn `lastTurn` minutes in. */
const talkedUntil = (lastTurn: number): InterviewProgress => ({
  ...freshProgress,
  person: "progress",
  told: true,
  mode: "talk",
  startedAt: start,
  seenAt: start + lastTurn * minute,
});

describe("the minutes left", () => {
  it("counts down from twenty minutes as the interview goes on", () => {
    expect({
      before: secondsLeft(freshProgress, start),
      atStart: secondsLeft(talkedUntil(0), start),
      sevenIn: secondsLeft(talkedUntil(7), start + 7 * minute),
    }).toStrictEqual({ before: 1200, atStart: 1200, sevenIn: 780 });
  });

  it("stands where they stopped when they come back the next day", () => {
    const nextDay = start + 24 * 60 * minute;
    // A gap of up to five minutes between turns is thinking time; the rest is time away.
    expect(secondsLeft(talkedUntil(7), nextDay)).toBe(780 - 5 * 60);
  });

  it("is never less than nothing", () => {
    expect(secondsLeft(talkedUntil(30), start + 30 * minute)).toBe(0);
  });
});

/** Which times are offered at `at`. */
const offered = (at: Date): string[] => remindTimes(at).map(({ id }) => id);

describe("the times to be reminded", () => {
  it("offers later today only while there is an afternoon left, and Monday unless tomorrow is", () => {
    expect({
      tuesdayMorning: offered(new Date(2026, 10, 24, 10, 0)),
      tuesdayEvening: offered(new Date(2026, 10, 24, 17, 0)),
      sunday: offered(new Date(2026, 10, 29, 10, 0)),
    }).toStrictEqual({
      tuesdayMorning: ["today", "tomorrow", "monday"],
      tuesdayEvening: ["tomorrow", "monday"],
      sunday: ["today", "tomorrow"],
    });
  });
});
