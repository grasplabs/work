import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { nearEnd } from "./clock.ts";

// CONCEPT ONLY: the interview's countdown, its one delight (Ruben, 24
// November: "a countdown... each number is a box, and it moves up"). It
// counts DOWN from 20:00; each digit stands in a small box of its own and,
// when it changes, the old digit slides up and out as the new one comes in
// from below, like an airport board. Only the digits that change move (the
// seconds' unit every second, the tens every ten). Quiet: the boxes on the
// muted surface with the system's edge and corner, the digits in the body's
// type with tabular numbers, no colour per tick; from 5:00 left the boxes
// take the warning tone; at 0:00 it stands still. Each roll is over within
// the library's `ui` duration on its curve; under reduced motion a digit
// simply changes. The boxes are decorative: one hidden line carries the
// time for a screen reader, and the marks (5 minutes, 1 minute, time's up)
// are said through clock.ts `useCountdownMarks`, never per second.

const rollOut = stylex.keyframes({
  from: { transform: "translateY(0)" },
  to: { transform: "translateY(-100%)" },
});
const rollIn = stylex.keyframes({
  from: { transform: "translateY(100%)" },
  to: { transform: "translateY(0)" },
});

const styles = stylex.create({
  row: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["1"],
  },
  box: {
    position: "relative",
    display: "inline-grid",
    overflow: "hidden",
    boxSizing: "border-box",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.muted,
    color: colors.foreground,
    fontFamily: font.sans,
    fontVariantNumeric: "tabular-nums",
    textAlign: "center",
  },
  // A: about the body text's height, quiet.
  small: {
    width: "1.25rem",
    height: "1.75rem",
    fontSize: font.textBase,
    lineHeight: "1.75rem",
  },
  // B: a real object on the screen.
  large: {
    width: "2.25rem",
    height: "3rem",
    fontSize: font.headingMd,
    lineHeight: "3rem",
  },
  warning: { borderColor: colors.warning, color: colors.warning },
  // Both digits stand in the box's one cell, one rolling out as the other rolls in.
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
  colon: {
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
  },
  colonSmall: { fontSize: font.textBase },
  colonLarge: { fontSize: font.headingMd },
  unit: { color: colors.mutedForeground, fontSize: font.textBase },
});

/** One digit in its box: the one before rolls up and out as this one rolls in. */
const Digit = ({
  value,
  size,
  warn,
}: {
  value: string;
  size: "small" | "large";
  warn: boolean;
}) => {
  // What stood here before, kept from the render that showed it, so only a change rolls.
  const [shown, setShown] = useState({ now: value, before: "" });
  if (shown.now !== value) {
    setShown({ now: value, before: shown.now });
  }
  return (
    <span {...stylex.props(styles.box, styles[size], warn && styles.warning)}>
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

/** The countdown's look: A small, B large, C minutes only. */
export type CountdownLook = "small" | "large" | "minutes";

/** The time left as a screen reader hears it, when it reads the line. */
const spoken = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes} minutes ${rest} seconds left`;
};

/** The interview's countdown: digits in boxes, rolling as they change. */
export const Countdown = ({
  left,
  look,
}: {
  /** Seconds left. */
  left: number;
  look: CountdownLook;
}) => {
  const seconds = Math.max(0, left);
  const warn = nearEnd(seconds);
  const size = look === "large" ? "large" : "small";
  if (look === "minutes") {
    const minutes = String(Math.ceil(seconds / 60)).padStart(2, "0");
    return (
      <span {...stylex.props(styles.row)}>
        <span
          {...stylex.props(visuallyHidden)}
        >{`${minutes} minutes left`}</span>
        <span aria-hidden="true" {...stylex.props(styles.row)}>
          <Digit size="small" value={minutes[0] ?? "0"} warn={warn} />
          <Digit size="small" value={minutes[1] ?? "0"} warn={warn} />
          <span {...stylex.props(styles.unit)}>min</span>
        </span>
      </span>
    );
  }
  const clock = `${String(Math.floor(seconds / 60)).padStart(2, "0")}${String(seconds % 60).padStart(2, "0")}`;
  return (
    <span {...stylex.props(styles.row)}>
      <span {...stylex.props(visuallyHidden)}>{spoken(seconds)}</span>
      <span aria-hidden="true" {...stylex.props(styles.row)}>
        <Digit size={size} value={clock[0] ?? "0"} warn={warn} />
        <Digit size={size} value={clock[1] ?? "0"} warn={warn} />
        <span
          {...stylex.props(
            styles.colon,
            size === "large" ? styles.colonLarge : styles.colonSmall
          )}
        >
          :
        </span>
        <Digit size={size} value={clock[2] ?? "0"} warn={warn} />
        <Digit size={size} value={clock[3] ?? "0"} warn={warn} />
      </span>
    </span>
  );
};
