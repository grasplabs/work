// DayPills: the days of the week something happens on, read-only, a small pill per day with its
// letter: filled in ink on the days it happens, soft on the others, and quieter while it is paused.
// A stand-in in work until Damsko has the part (DAMS-4's gap list, "Day pills"); work's agent page
// is its first user (agents/agent-overview.tsx).
//
//   <DayPills days={[{ letter: "M", name: "Monday: runs", on: true }, …]} label="Days it runs" />
//   <DayPills days={days} label="Days it runs" tone="paused" />
//
// A screen reader hears the label and each day's words (its whole name and whether it is on): the
// letters alone are drawn. Every value is a token. A caller may set layout only.
import * as stylex from "@stylexjs/stylex";

import { visuallyHidden } from "../hidden/hidden";
import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";

/** One day: its letter as drawn, what a screen reader hears for it ("Monday: runs"), and whether it is one of the days. */
export interface DayPill {
  letter: string;
  name: string;
  on: boolean;
}

/** Every prop DayPills takes. */
export interface DayPillsProps {
  /** The week's days in the order they are drawn. */
  days: readonly DayPill[];
  /** What the days are, to a screen reader: "Runs on". */
  label: string;
  /**
   * `on` the chosen days in ink; `paused` the same days quieter, while it doesn't happen.
   * @default "on"
   */
  tone?: "on" | "paused";
  /** Layout only: margins and alignment. */
  layout?: LayoutStyle;
}

const styles = stylex.create({
  list: {
    display: "flex",
    flexWrap: "wrap",
    gap: grasp.space2,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  pill: {
    display: "inline-grid",
    placeItems: "center",
    boxSizing: "border-box",
    width: grasp.controlSm,
    height: grasp.controlSm,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: 1,
    fontWeight: grasp.weightMedium,
    userSelect: "none",
    outline: { default: "none", [media.forced]: "1px solid CanvasText" },
    outlineOffset: "-1px",
  },
  off: { color: grasp.muted, backgroundColor: grasp.soft },
  // In forced colours backgrounds are gone: a day it runs keeps a thicker ring.
  on: {
    color: grasp.paper,
    backgroundColor: grasp.ink,
    outline: { default: "none", [media.forced]: "3px solid CanvasText" },
    outlineOffset: { default: "-1px", [media.forced]: "-3px" },
  },
  paused: {
    color: grasp.paper,
    backgroundColor: grasp.muted,
    outline: { default: "none", [media.forced]: "3px solid CanvasText" },
    outlineOffset: { default: "-1px", [media.forced]: "-3px" },
  },
});

export const DayPills = ({
  days,
  label,
  tone = "on",
  layout,
}: DayPillsProps) => (
  <ul
    aria-label={label}
    data-slot="day-pills"
    {...stylex.props(styles.list, layout)}
  >
    {days.map((day) => (
      <li
        key={day.name}
        {...stylex.props(
          styles.pill,
          day.on && styles[tone],
          !day.on && styles.off
        )}
      >
        <span aria-hidden="true">{day.letter}</span>
        <span {...stylex.props(visuallyHidden)}>{day.name}</span>
      </li>
    ))}
  </ul>
);
