import type { InterviewProgress } from "@grasp-os/shared/interview-links";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, duration, font, media } from "@grasp-os/ui/lib/tokens.stylex";
import { announce } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

import { minutesAt, ticked } from "./progress.ts";

// The interview's countdown, its one delight: the minutes and seconds left
// of the one budget (20 minutes), counting down from 20:00 in the body's
// words, with tabular numbers and no leading zero (19:42, 5:00, 0:00).
// Each digit stands in a cell of its own that cannot be seen and only
// clips the roll: when a digit changes, the old one
// slides up and out as the new one comes in from below, like an airport
// board. Only the digits that change move. No fill, edge or shadow; the
// colon is plain text. From 5:00 left it takes the warning colour; at 0:00
// it stands still. Each roll is over within the library's `ui` duration on
// its curve; under reduced motion a digit simply changes. The digits are
// decorative: one hidden line carries the time for a screen reader, and
// the marks (5 minutes, 1 minute, time's up) are said through the page's
// live region, never every second.

/** The interview's one budget, in minutes, said the same everywhere. */
export const budgetMinutes = 20;
const budgetSeconds = budgetMinutes * 60;
/** From this many seconds left the countdown shows the end is near. */
const nearSeconds = 5 * 60;

/**
 * Seconds left at `at`: the budget less the minutes the interview has
 * taken, as Stephen is told them (`minutesAt`), the time away since their
 * last turn already left out, so someone back the next day is where they
 * stopped, not at the end of the clock.
 */
export const secondsLeft = (progress: InterviewProgress, at: number): number =>
  Math.max(
    0,
    Math.round(budgetSeconds - minutesAt(ticked(progress, at), at) * 60)
  );

/** Runs `then` once a second until stopped. */
const everySecond = (then: () => void): (() => void) => {
  const id = window.setInterval(then, 1000);
  return () => {
    window.clearInterval(id);
  };
};

/** The time now, again each second while `running`; standing still while it isn't. */
export const useNow = (running: boolean): number => {
  const [now, setNow] = useState(Date.now);
  useEffect(
    () =>
      running
        ? everySecond(() => {
            setNow(Date.now());
          })
        : undefined,
    [running]
  );
  return now;
};

/**
 * Says the countdown at its marks only (5 minutes left, 1 minute left, the
 * end), through the page's one live region, never every second.
 */
export const useCountdownMarks = (left: number, running: boolean): void => {
  const { t } = useLingui();
  let words = "";
  if (running && left === nearSeconds) {
    words = t`5 minutes left`;
  } else if (running && left === 60) {
    words = t`1 minute left`;
  } else if (running && left === 0) {
    words = t`Time’s up`;
  }
  useEffect(() => {
    if (words !== "") {
      announce(words);
    }
  }, [words]);
};

const rollOut = stylex.keyframes({
  from: { transform: "translateY(0)" },
  to: { transform: "translateY(-100%)" },
});
const rollIn = stylex.keyframes({
  from: { transform: "translateY(100%)" },
  to: { transform: "translateY(0)" },
});

const styles = stylex.create({
  // The body's words: its family, size, line and colour.
  row: {
    display: "inline-flex",
    alignItems: "center",
    fontFamily: font.sans,
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    fontVariantNumeric: "tabular-nums",
    color: colors.bodyForeground,
  },
  warning: { color: colors.warning },
  // One digit's cell: a tabular digit wide and a line high, clipped top and bottom only, so a
  // resting digit is never cut at its sides.
  cell: {
    display: "inline-grid",
    width: "1ch",
    height: font.textBaseLine,
    overflowX: "visible",
    overflowY: "clip",
    textAlign: "center",
  },
  // Both digits stand in the cell's one place, one rolling out as the other rolls in.
  digit: { gridArea: "1 / 1" },
  out: {
    animationName: { default: rollOut, [media.reducedMotion]: "none" },
    animationDuration: duration.ui,
    animationTimingFunction: duration.ease,
    animationFillMode: "forwards",
    visibility: { default: null, [media.reducedMotion]: "hidden" },
  },
  in: {
    animationName: { default: rollIn, [media.reducedMotion]: "none" },
    animationDuration: duration.ui,
    animationTimingFunction: duration.ease,
  },
});

/** One digit in its cell: the one before rolls up and out as this one rolls in. */
const Digit = ({ value }: { value: string }) => {
  // What stood here before, kept from the render that showed it, so only a change rolls.
  const [shown, setShown] = useState({ now: value, before: "" });
  if (shown.now !== value) {
    setShown({ now: value, before: shown.now });
  }
  return (
    <span aria-hidden="true" {...stylex.props(styles.cell)}>
      {shown.before === "" ? null : (
        <span
          key={`out-${shown.before}-${value}`}
          {...stylex.props(styles.digit, styles.out)}
        >
          {shown.before}
        </span>
      )}
      <span
        key={`in-${value}`}
        {...stylex.props(styles.digit, shown.before !== "" && styles.in)}
      >
        {value}
      </span>
    </span>
  );
};

/** Seconds as the countdown shows them: minutes without a leading zero, then two digits of seconds (19:42, 5:00, 0:00). */
export const clockOf = (seconds: number): string => {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/** The interview's countdown: the minutes and seconds left, each digit rolling as it changes. */
export const Countdown = ({
  left,
}: {
  /** Seconds left. */
  left: number;
}) => {
  const { t } = useLingui();
  const seconds = Math.max(0, Math.round(left));
  const clock = clockOf(seconds);
  const [minutes = "0", secs = "00"] = clock.split(":");
  return (
    <span
      {...stylex.props(styles.row, seconds <= nearSeconds && styles.warning)}
    >
      <span {...stylex.props(visuallyHidden)}>{t`Time left: ${clock}`}</span>
      {/* The tens of minutes only while there are any: 19:42, then 9:59, never 09:59. */}
      {minutes.length > 1 ? <Digit value={minutes.slice(0, 1)} /> : null}
      <Digit value={minutes.slice(-1)} />
      <span aria-hidden="true">:</span>
      <Digit value={secs.slice(0, 1)} />
      <Digit value={secs.slice(1)} />
    </span>
  );
};
