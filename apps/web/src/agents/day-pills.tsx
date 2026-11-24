// DayPills: the days of the week something happens on, read-only, a small pill per day with its
// letter: filled in ink on the days it happens, soft on the others, and quieter while it is paused.
// The product's own until Damsko has the part (DAMS-4's gap list, "Day pills"), as #2503 drew it;
// the agent's page is its one user (agent-overview.tsx).
//
//   <DayPills days={[{ letter: "M", name: "Monday: runs", on: true }, …]} label="Days it runs" />
//   <DayPills days={days} label="Days it runs" tone="paused" />
//
// A screen reader hears the label and each day's words (its whole name and whether it is on): the
// letters alone are drawn. Every value is a token. A caller may set layout only.
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import {
  colors,
  font,
  media,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

/** One day: its letter as drawn, what a screen reader hears for it ("Monday: runs"), and whether it is one of the days. */
interface DayPill {
  letter: string;
  name: string;
  on: boolean;
}

/** Every prop DayPills takes. */
interface DayPillsProps {
  /** The week's days in the order they are drawn. */
  days: readonly DayPill[];
  /** What the days are, to a screen reader: "Runs on". */
  label: string;
  /**
   * `on` the chosen days in ink; `paused` the same days quieter, while it doesn't happen.
   * @default "on"
   */
  tone?: "on" | "paused";
}

const styles = stylex.create({
  list: {
    display: "flex",
    flexWrap: "wrap",
    gap: space[2],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  pill: {
    display: "inline-grid",
    placeItems: "center",
    boxSizing: "border-box",
    width: size.controlSm,
    height: size.controlSm,
    borderRadius: radius.base,
    cornerShape: radius.shape,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: 1,
    fontWeight: font.weightMedium,
    userSelect: "none",
    outline: { default: "none", [media.forcedColors]: "1px solid CanvasText" },
    outlineOffset: "-1px",
  },
  off: { color: colors.mutedForeground, backgroundColor: colors.muted },
  // In forced colours backgrounds are gone: a day it runs keeps a thicker ring.
  on: {
    color: colors.background,
    backgroundColor: colors.foreground,
    outline: { default: "none", [media.forcedColors]: "3px solid CanvasText" },
    outlineOffset: { default: "-1px", [media.forcedColors]: "-3px" },
  },
  paused: {
    color: colors.background,
    backgroundColor: colors.mutedForeground,
    outline: { default: "none", [media.forcedColors]: "3px solid CanvasText" },
    outlineOffset: { default: "-1px", [media.forcedColors]: "-3px" },
  },
});

export const DayPills = ({ days, label, tone = "on" }: DayPillsProps) => (
  <ul aria-label={label} data-slot="day-pills" {...stylex.props(styles.list)}>
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
