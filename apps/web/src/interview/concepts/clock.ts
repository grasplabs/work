import { announce } from "@grasp-os/ui/lib/utils";
import { useEffect, useState } from "react";

import { copy, fixture } from "./fixture.ts";

// CONCEPT ONLY: the interview’s countdown. It runs from the first second of
// the conversation over the one budget (20 minutes), shown as time USED,
// going forward ("12 of 20 minutes": a bar never goes backwards), said
// aloud only at its marks; a page
// opened with `&left=<minutes>` starts there, so the moments at 5 and at 0
// can be seen without waiting. Frozen, it stands still for a screenshot.

/** The whole budget, in seconds. */
export const budgetSeconds = fixture.minutes * 60;
/** When the interviewer wraps up, in seconds left. */
export const wrapUpSeconds = fixture.wrapUpMinutes * 60;

/** Runs `then` once a second until stopped. */
const everySecond = (then: () => void): (() => void) => {
  const id = window.setInterval(then, 1000);
  return () => {
    window.clearInterval(id);
  };
};

/** Seconds left, counting down once a second while `running`. */
export const useCountdown = (
  startSeconds: number,
  running: boolean
): number => {
  const [left, setLeft] = useState(startSeconds);
  useEffect(
    () =>
      running
        ? everySecond(() => {
            setLeft((now) => Math.max(0, now - 1));
          })
        : undefined,
    [running]
  );
  return left;
};

/** The minutes used, going forward: "12 / 20 min". */
export const usedWords = (left: number): string => {
  const used = Math.min(
    fixture.minutes,
    Math.floor((budgetSeconds - left) / 60)
  );
  return copy.clock.used(used);
};

/** Seconds used, for a Progress that only ever goes forward. */
export const usedSeconds = (left: number): number => budgetSeconds - left;

/** Near the end: the interviewer wraps up, and the countdown shows it (`warning`). */
export const nearEnd = (left: number): boolean => left <= wrapUpSeconds;

/** The marks said aloud, and nothing in between. */
const marks = [
  { at: wrapUpSeconds, words: copy.clock.mark5 },
  { at: 60, words: copy.clock.mark1 },
  { at: 0, words: copy.clock.mark0 },
] as const;

/**
 * Says the countdown at its marks only (5 minutes left, 1 minute left, the
 * end), through the page's one live region, never every second.
 */
export const useCountdownMarks = (left: number, running: boolean): void => {
  const mark = marks.find(({ at }) => left === at);
  const words = running ? (mark?.words ?? "") : "";
  useEffect(() => {
    if (words !== "") {
      announce(words);
    }
  }, [words]);
};
