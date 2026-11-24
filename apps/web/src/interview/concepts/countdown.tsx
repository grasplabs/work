import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, duration, font, media } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { nearEnd } from "./clock.ts";

// CONCEPT ONLY: the interview's countdown, its one delight (Ruben, 24
// November: "imagine the boxes to be invisible. I like just the countdown").
// It counts DOWN from 20:00 in the body's words, with tabular numbers; each
// digit stands in a cell of its own that cannot be seen and only clips the
// roll: when a digit changes, the old one slides up and out as the new one
// comes in from below, like an airport board. Only the digits that change
// move (the seconds' unit every second, the tens every ten). No fill, edge
// or shadow; the colon is plain text. From 5:00 left it takes the warning
// colour; at 0:00 it stands still. Each roll is over within the library's
// `ui` duration on its curve; under reduced motion a digit simply changes.
// The digits are decorative: one hidden line carries the time for a screen
// reader, and the marks (5 minutes, 1 minute, time's up) are said through
// clock.ts `useCountdownMarks`, never per second.

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

/** The time left as a screen reader hears it, when it reads the line. */
const spoken = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes} minutes ${rest} seconds left`;
};

/** The interview's countdown: the minutes and seconds left, each digit rolling as it changes. */
export const Countdown = ({
  left,
}: {
  /** Seconds left. */
  left: number;
}) => {
  const seconds = Math.max(0, Math.round(left));
  const clock = `${String(Math.floor(seconds / 60)).padStart(2, "0")}${String(seconds % 60).padStart(2, "0")}`;
  return (
    <span {...stylex.props(styles.row, nearEnd(seconds) && styles.warning)}>
      <span {...stylex.props(visuallyHidden)}>{spoken(seconds)}</span>
      <Digit value={clock[0] ?? "0"} />
      <Digit value={clock[1] ?? "0"} />
      <span aria-hidden="true">:</span>
      <Digit value={clock[2] ?? "0"} />
      <Digit value={clock[3] ?? "0"} />
    </span>
  );
};
