import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, duration, font, media } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { nearEnd } from "./clock.ts";

// CONCEPT ONLY: the interview's countdown, its one delight, as Ruben chose it
// (24 November: "imagine the boxes to be invisible... I like just the
// countdown"). It counts DOWN from 20:00 in the body's own type and tone
// (`Text size="lg"`, tabular numbers): no box, no fill, no edge, no label.
// Each digit keeps an invisible cell of its own width that clips its roll:
// when it changes the old digit slides up and out as the new one comes in
// from below, within `duration.ui` on `duration.ease`; only changed digits
// move; a soft fade at the cell's top and bottom, so the clip never shows as
// a hard line, and a cell tall enough that a digit at rest is never cut.
// Under reduced motion a digit simply changes. From 5:00 only the digits take
// `colors.warning`; at 0:00 it stands still. One hidden line carries the time
// for a screen reader; the marks (5 minutes, 1 minute, time's up) are said
// through clock.ts `useCountdownMarks`, never per second.

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
    color: colors.bodyForeground,
    fontFamily: font.sans,
    fontSize: font.textLg,
    lineHeight: font.textLgLine,
    fontVariantNumeric: "tabular-nums",
  },
  // The digits in a row, in the row's colour.
  digits: { display: "inline-flex", alignItems: "center" },
  warning: { color: colors.warning },
  // A digit's invisible cell: one figure wide, a little taller than the line, so a digit at rest
  // stands clear of the soft fade at its edges.
  cell: {
    display: "inline-grid",
    overflow: "hidden",
    width: "1ch",
    height: "1.6em",
    lineHeight: "1.6em",
    textAlign: "center",
    maskImage:
      "linear-gradient(to bottom, transparent, #000 18%, #000 82%, transparent)",
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

/** One digit in its invisible cell: the one before rolls up and out as this one rolls in. */
const Digit = ({ value }: { value: string }) => {
  // What stood here before, kept from the render that showed it, so only a change rolls.
  const [shown, setShown] = useState({ now: value, before: "" });
  if (shown.now !== value) {
    setShown({ now: value, before: shown.now });
  }
  return (
    <span {...stylex.props(styles.cell)}>
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
const spoken = (seconds: number): string =>
  `${Math.floor(seconds / 60)} minutes ${seconds % 60} seconds left`;

/** The interview's countdown: 19:42, each digit rolling as it changes. */
export const Countdown = ({ left }: { left: number }) => {
  const seconds = Math.max(0, left);
  // Minutes as they are said (19:42, 5:00, 0:00): no leading zero.
  const minutes = String(Math.floor(seconds / 60));
  const secs = String(seconds % 60).padStart(2, "0");
  return (
    <span {...stylex.props(styles.row, nearEnd(seconds) && styles.warning)}>
      <span {...stylex.props(visuallyHidden)}>{spoken(seconds)}</span>
      <span aria-hidden="true" {...stylex.props(styles.digits)}>
        {minutes.length > 1 ? <Digit value={minutes.slice(0, 1)} /> : null}
        <Digit value={minutes.slice(-1)} />
        :
        <Digit value={secs.slice(0, 1)} />
        <Digit value={secs.slice(1)} />
      </span>
    </span>
  );
};
