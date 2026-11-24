import { useEffect, useState } from "react";

import { fixture } from "./fixture.ts";

// CONCEPT ONLY: the interview’s countdown. It runs from the first second of
// the conversation and counts down the one budget (20 minutes); a page
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

/** The minutes left, rounded up: "18 min left", "1 min left", "Time is up". */
export const shortLeft = (seconds: number): string => {
  if (seconds <= 0) {
    return "Time is up";
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} min left`;
};

/** The same in a whole sentence, for a screen reader and the bar’s words. */
export const longLeft = (seconds: number): string => {
  if (seconds <= 0) {
    return "The 20 minutes are up";
  }
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1
    ? "About 1 minute left"
    : `About ${minutes} minutes left`;
};
