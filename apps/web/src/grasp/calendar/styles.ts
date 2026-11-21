// The look of a calendar (calendar.tsx). UI SDK's Calendar marks each day with its state
// (data-selected, data-today, data-outside, data-unavailable, data-disabled, and a range's start,
// middle and end); these styles read them.
import * as stylex from "@stylexjs/stylex";

import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

const chosen = ":is([data-selected]:not([data-range-middle]))";
const middle =
  ":is([data-range-middle], [data-preview]:not([data-range-start], [data-range-end]))";
// A day of a range with the keyboard's ring. Weighed above the range's own corners (four parts to
// their three), so it wins wherever the sheet puts it.
const ringed =
  ":focus-visible:is([data-range-start], [data-range-end], [data-range-middle], [data-preview]):not([data-disabled])";
const off = ":is([data-disabled], [data-unavailable])";
const day = {
  default: grasp.calendarDay,
  [media.coarse]: grasp.calendarDayTouch,
};

export const calendarStyles = stylex.create({
  root: {
    display: "inline-flex",
    flexDirection: "column",
    gap: grasp.space3,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.text,
  },
  // Months side by side, wrapping under each other on a narrow screen: each from the top, so a
  // month of six weeks and one of five keep one height of week; stacked, in the middle, under the
  // heading that spans them.
  months: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
    justifyContent: "center",
    gap: grasp.space6,
  },
  month: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
  },
  // Previous, the month's name and Next, on one line.
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space2,
  },
  heading: {
    flexGrow: 1,
    margin: 0,
    textAlign: "center",
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  headingStacked: { clipPath: "inset(50%)" },
  // The weeks stand a little apart, so a day's keyboard ring (it stands off the day) clears the
  // week above and below, and chosen days in a column never stack into what reads as a range. The
  // days of a week meet, so a range's band runs through them.
  grid: {
    borderCollapse: "separate",
    borderSpacing: `0 ${grasp.space1}`,
    fontVariantNumeric: "tabular-nums",
  },
  weekday: {
    width: day,
    height: grasp.calendarDay,
    padding: 0,
    fontSize: grasp.textXs,
    fontWeight: grasp.weightMedium,
    color: grasp.muted,
    textAlign: "center",
  },
  // A month's own name over its days, shown while the months are stacked (the heading's look).
  monthName: {
    paddingBlockEnd: grasp.space2,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
    textAlign: "center",
  },
  // A day: a square the size of a small control, its number in the middle. Hover lights it;
  // chosen is the first action's colour; inside a range a quiet fill joins the ends.
  day: {
    boxSizing: "border-box",
    width: day,
    height: day,
    padding: 0,
    textAlign: "center",
    verticalAlign: "middle",
    borderRadius: grasp.cornerMark,
    cursor: { default: "pointer", [off]: "default" },
    color: {
      default: grasp.text,
      ":is([data-outside])": grasp.quiet,
      [off]: grasp.quiet,
      ":is([data-today])": grasp.ink,
      [middle]: grasp.ink,
      [chosen]: {
        default: grasp.calendarTextChosen,
        [media.forced]: "SelectedItemText",
      },
    },
    fontWeight: { default: null, ":is([data-today])": grasp.weightMedium },
    textDecorationLine: {
      default: null,
      ":is([data-unavailable])": "line-through",
      ":is([data-today], [data-range-middle])": {
        default: null,
        [media.forced]: "underline",
      },
      // Inside a range today's own fill gives way to the band's: it keeps an underline, so it is
      // still found at a glance (A2-date-range-picker-04).
      ":is([data-today]):is([data-range-middle], [data-preview]:not([data-range-start], [data-range-end]))":
        "underline",
    },
    textDecorationThickness: grasp.ringWidth,
    textUnderlineOffset: grasp.space1,
    backgroundColor: {
      default: "transparent",
      ":hover:not([data-selected], [data-range-middle], [data-today], [data-preview])":
        { default: null, [media.hover]: grasp.ghostFillHover },
      ":is([data-today])": grasp.calendarFillToday,
      [middle]: grasp.calendarFillRange,
      [chosen]: {
        default: grasp.calendarFillChosen,
        [media.forced]: "SelectedItem",
      },
    },
    // A fill stands 2px in from its day's every side, so filled days beside or above each other
    // (today and a chosen day, chosen days in a column) are told apart, and the keyboard's ring,
    // standing off its day, ends clear of the fill above. A range's days join where they meet.
    borderStyle: "solid",
    borderColor: "transparent",
    borderBlockWidth: 2,
    borderInlineStartWidth: {
      default: 2,
      [middle]: 0,
      ":is([data-range-end]):not([data-range-start])": 0,
    },
    borderInlineEndWidth: {
      default: 2,
      [middle]: 0,
      ":is([data-range-start]):not([data-range-end])": 0,
    },
    backgroundClip: "padding-box",
    // A range joins its days into one band: no corner where two days meet. A day with the keyboard's
    // ring keeps its own corner, so the ring, which follows it, is never square inside the band.
    borderStartEndRadius: {
      default: grasp.cornerMark,
      ":is([data-range-start]):not([data-range-end])": 0,
      [middle]: 0,
      [ringed]: grasp.cornerMark,
    },
    borderEndEndRadius: {
      default: grasp.cornerMark,
      ":is([data-range-start]):not([data-range-end])": 0,
      [middle]: 0,
      [ringed]: grasp.cornerMark,
    },
    borderStartStartRadius: {
      default: grasp.cornerMark,
      ":is([data-range-end]):not([data-range-start])": 0,
      [middle]: 0,
      [ringed]: grasp.cornerMark,
    },
    borderEndStartRadius: {
      default: grasp.cornerMark,
      ":is([data-range-end]):not([data-range-start])": 0,
      [middle]: 0,
      [ringed]: grasp.cornerMark,
    },
    opacity: { default: 1, ":is([data-disabled])": grasp.dim },
    // In forced colours fills are dropped: chosen days take the system's own highlight, and
    // today and a range's middle are underlined.
    forcedColorAdjust: { default: null, [media.forced]: "none" },
    transitionProperty: "background-color, color",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
  },
});
