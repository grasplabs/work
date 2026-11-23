// Calendar: a month of days to choose one date, several, or a range from, built on UI SDK's Calendar: small
// type, the month's name between Previous and Next (ghost Buttons), weekdays in muted words, and
// days the size of a small control. A chosen day takes the first action's colour; a range joins its
// days in a quiet band.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <Calendar defaultValue="2026-11-16" />
//   <Calendar mode="range" defaultValue={["2026-11-10", "2026-11-14"]} numberOfMonths={2} />
//
// Dates are ISO strings ("2026-11-16"), with no time or time zone. The arrow keys move through the
// days, Home and End to the week's ends, Page Up and Page Down through the months (with Shift, the
// years). The month's and the weekdays' names come from the page's language (`useLocale()`, else the
// page's `lang`) through Intl, and so does the first day of the week; Previous and Next are named by
// the I18nProvider (`calendar.previous`, `calendar.next`).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Calendar as CalendarPrimitive,
  CalendarDay as DayPrimitive,
  CalendarGrid as GridPrimitive,
  CalendarHeading as HeadingPrimitive,
  CalendarNext as NextPrimitive,
  CalendarPrevious as PreviousPrimitive,
  CalendarWeekday as WeekdayPrimitive,
  CalendarWeekdays as WeekdaysPrimitive,
  CalendarWeeks as WeeksPrimitive,
} from "@ui-sdk/react/calendar";
import type { CalendarGridState } from "@ui-sdk/react/calendar";
import { useEffect, useState } from "react";
import type { ComponentProps, ReactNode } from "react";

import { useI18n, useLocale } from "../lib/i18n";
import { ChevronLeftIcon, ChevronRightIcon, Icon } from "../lib/icons";
import { focusRingOffset, visuallyHidden } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";
import { motionVars } from "../lib/vars.stylex";
import { Button } from "./button";

// ---- The look -----------------------------------------------------------------------------------
//
// UI SDK's Calendar marks each day with its state (data-selected, data-today, data-outside,
// data-unavailable, data-disabled, and a range's start, middle and end); these styles read them.

const chosen = ":is([data-selected]:not([data-range-middle]))";
const middle =
  ":is([data-range-middle], [data-preview]:not([data-range-start], [data-range-end]))";
// A day of a range with the keyboard's ring. Weighed above the range's own corners (four parts to
// their three), so it wins wherever the sheet puts it.
const ringed =
  ":focus-visible:is([data-range-start], [data-range-end], [data-range-middle], [data-preview]):not([data-disabled])";
const off = ":is([data-disabled], [data-unavailable])";
const daySize = {
  default: size.calendarDay,
  [media.pointerCoarse]: size.calendarDayTouch,
};

const styles = stylex.create({
  root: {
    display: "inline-flex",
    flexDirection: "column",
    gap: space[3],
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.bodyForeground,
  },
  // Months side by side, wrapping under each other on a narrow screen: each from the top, so a
  // month of six weeks and one of five keep one height of week; stacked, in the middle, under the
  // heading that spans them.
  months: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
    justifyContent: "center",
    gap: space[6],
  },
  // Previous, the month's name and Next, on one line.
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space[2],
  },
  heading: {
    flexGrow: 1,
    margin: 0,
    textAlign: "center",
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
  },
  // Stacked, each month names itself over its days, so the heading's words would read twice
  // ("November – December 2026" over "November 2026"): unseen, still read, and its room kept so
  // Previous and Next stay at the ends.
  headingStacked: { clipPath: "inset(50%)" },
  // The weeks stand a little apart, so a day's keyboard ring (it stands off the day) clears the
  // week above and below, and chosen days in a column never stack into what reads as a range. The
  // days of a week meet, so a range's band runs through them.
  grid: {
    borderCollapse: "separate",
    borderSpacing: `0 ${space[1]}`,
    fontVariantNumeric: "tabular-nums",
  },
  weekday: {
    width: daySize,
    height: size.calendarDay,
    padding: 0,
    fontSize: font.textXs,
    fontWeight: font.weightMedium,
    color: colors.mutedForeground,
    textAlign: "center",
  },
  // A month's own name over its days, shown while the months are stacked (the heading's look).
  monthName: {
    paddingBlockEnd: space[2],
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
    textAlign: "center",
  },
  // A day: a square the size of a small control, its number in the middle. Hover lights it;
  // chosen is the first action's colour; inside a range a quiet fill joins the ends.
  day: {
    boxSizing: "border-box",
    width: daySize,
    height: daySize,
    padding: 0,
    textAlign: "center",
    verticalAlign: "middle",
    borderRadius: radius.mark,
    cornerShape: radius.shape,
    cursor: { default: "pointer", [off]: "default" },
    color: {
      default: colors.bodyForeground,
      ":is([data-outside])": colors.subtleForeground,
      [off]: colors.subtleForeground,
      ":is([data-today])": colors.foreground,
      [middle]: colors.foreground,
      [chosen]: {
        default: colors.calendarForegroundSelected,
        [media.forcedColors]: "SelectedItemText",
      },
    },
    fontWeight: { default: null, ":is([data-today])": font.weightMedium },
    textDecorationLine: {
      default: null,
      ":is([data-unavailable])": "line-through",
      ":is([data-today], [data-range-middle])": {
        default: null,
        [media.forcedColors]: "underline",
      },
      // Inside a range today's own fill gives way to the band's: it keeps an underline, so it is
      // still found at a glance.
      ":is([data-today]):is([data-range-middle], [data-preview]:not([data-range-start], [data-range-end]))":
        "underline",
    },
    textDecorationThickness: size.lineStrong,
    textUnderlineOffset: space[1],
    backgroundColor: {
      default: "transparent",
      ":hover:not([data-selected], [data-range-middle], [data-today], [data-preview])":
        { default: null, [media.hover]: colors.accent },
      ":is([data-today])": colors.calendarBgToday,
      [middle]: colors.calendarBgRange,
      [chosen]: {
        default: colors.calendarBgSelected,
        [media.forcedColors]: "SelectedItem",
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
      default: radius.mark,
      ":is([data-range-start]):not([data-range-end])": 0,
      [middle]: 0,
      [ringed]: radius.mark,
    },
    borderEndEndRadius: {
      default: radius.mark,
      ":is([data-range-start]):not([data-range-end])": 0,
      [middle]: 0,
      [ringed]: radius.mark,
    },
    borderStartStartRadius: {
      default: radius.mark,
      ":is([data-range-end]):not([data-range-start])": 0,
      [middle]: 0,
      [ringed]: radius.mark,
    },
    borderEndStartRadius: {
      default: radius.mark,
      ":is([data-range-end]):not([data-range-start])": 0,
      [middle]: 0,
      [ringed]: radius.mark,
    },
    opacity: { default: 1, ":is([data-disabled])": size.opacityDisabled },
    // In forced colours fills are dropped: chosen days take the system's own highlight, and
    // today and a range's middle are underlined.
    forcedColorAdjust: { default: null, [media.forcedColors]: "none" },
    transitionProperty: "background-color, color",
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
  },
});

// ---- The parts ----------------------------------------------------------------------------------

type RootProps = ComponentProps<typeof CalendarPrimitive>;

/** Every prop a Calendar takes: these, and the rest of UI SDK's Calendar. */
export interface CalendarProps extends Omit<
  RootProps,
  | "children"
  | "render"
  | "className"
  | "style"
  | "mode"
  | "value"
  | "defaultValue"
  | "onValueChange"
  | "months"
> {
  /**
   * How many dates it chooses: `single` one, `range` a start and an end, `multiple` any number.
   * @default "single"
   */
  mode?: RootProps["mode"];
  /**
   * The chosen value: an ISO date for `single`, `[start, end]` for `range`, a list for
   * `multiple`, or `null`. Pass it with `onValueChange` to hold the value yourself.
   */
  value?: RootProps["value"];
  /** The value it starts with, when it holds its own. */
  defaultValue?: RootProps["defaultValue"];
  /** Runs when a date is chosen; a range runs once both its ends are chosen. */
  onValueChange?: RootProps["onValueChange"];
  /**
   * How many months show side by side. Two suit a range.
   * @default 1
   */
  numberOfMonths?: number;
  /** The earliest date that can be chosen, as an ISO date. Previous stops at its month. */
  min?: string;
  /** The latest date that can be chosen, as an ISO date. Next stops at its month. */
  max?: string;
  /**
   * Dates that cannot be chosen, such as booked days: ISO dates, `{ from, to }`,
   * `{ weekday: [0, 6] }` for weekends, `{ before }` or `{ after }`. They stay in the keys' path,
   * so a screen reader hears them, and are struck through.
   */
  unavailable?: RootProps["unavailable"];
  /**
   * Whether the days of the months before and after show at the grid's edges, in a quieter colour.
   * Shown for one month; with two or more side by side the next month shows those days itself.
   * @default true for one month, false for more
   */
  showOutsideDays?: boolean;
  /**
   * The language of the month's and the weekdays' names, as a BCP 47 tag ("nl-NL").
   * @default the I18nProvider's `locale`, else the page's `lang`
   */
  locale?: string;
  /**
   * The first day of the week, 0 for Sunday, 1 for Monday.
   * @default the locale's
   */
  weekStartsOn?: number;
  /** Where it sits: margins and alignment. Its look belongs to the calendar. */
  style?: LayoutStyle;
}

/** Says whether the months have wrapped under each other (a narrow screen), now and on each resize. */
const watchStacked = (
  row: HTMLElement,
  setStacked: (stacked: boolean) => void
) => {
  const measure = () => {
    const [first, second] = [...row.children];
    setStacked(
      first !== undefined &&
        second !== undefined &&
        second.getBoundingClientRect().top >
          first.getBoundingClientRect().top + 1
    );
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(row);
  return () => {
    observer.disconnect();
  };
};

/** Every prop a CalendarMonths takes. */
export interface CalendarMonthsProps {
  /** How many months show side by side. */
  numberOfMonths: number;
}

/**
 * Previous, the month's name and Next, then the days of each month shown: Calendar's inside. It
 * reads the nearest UI SDK calendar, so DatePicker draws the same months in its popup.
 */
export const CalendarMonths = ({
  numberOfMonths: count,
}: CalendarMonthsProps) => {
  const { previous, next } = useI18n().calendar;
  const dayLook = stylex.props(styles.day, focusRingOffset);
  // Side by side, the heading names both months ("November – December"). Stacked under each other,
  // each month shows its own name over its days, or the second reads as more of the first.
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const [stacked, setStacked] = useState(false);
  useEffect(
    () => (row === null ? undefined : watchStacked(row, setStacked)),
    [row]
  );
  return (
    <>
      <div {...stylex.props(styles.head)}>
        <PreviousPrimitive
          render={({
            children: _children,
            ...props
          }: Record<string, unknown>) => (
            <Button
              {...props}
              variant="ghost"
              size="icon-sm"
              aria-label={previous}
            >
              <Icon icon={ChevronLeftIcon} />
            </Button>
          )}
        />
        <HeadingPrimitive
          {...stylex.props(
            styles.heading,
            stacked && count > 1 && styles.headingStacked
          )}
        />
        <NextPrimitive
          render={({
            children: _children,
            ...props
          }: Record<string, unknown>) => (
            <Button {...props} variant="ghost" size="icon-sm" aria-label={next}>
              <Icon icon={ChevronRightIcon} />
            </Button>
          )}
        />
      </div>
      <div ref={setRow} {...stylex.props(styles.months)}>
        {Array.from({ length: count }, (_, offset) => (
          <GridPrimitive
            key={offset}
            offset={offset}
            render={(
              {
                children,
                ...props
              }: { children?: ReactNode } & Record<string, unknown>,
              state: CalendarGridState
            ) => (
              <table {...props}>
                <caption
                  {...stylex.props(
                    styles.monthName,
                    !stacked && visuallyHidden
                  )}
                >
                  {state.label}
                </caption>
                {children}
              </table>
            )}
            {...stylex.props(styles.grid)}
          >
            <WeekdaysPrimitive>
              {(index) => (
                <WeekdayPrimitive
                  index={index}
                  {...stylex.props(styles.weekday)}
                />
              )}
            </WeekdaysPrimitive>
            <WeeksPrimitive>
              {(cell) => <DayPrimitive value={cell.date} {...dayLook} />}
            </WeeksPrimitive>
          </GridPrimitive>
        ))}
      </div>
    </>
  );
};

/** A month of days to choose from, with Previous and Next. */
export const Calendar = ({
  numberOfMonths = 1,
  showOutsideDays,
  locale,
  style,
  ...rest
}: CalendarProps) => {
  const pageLocale = useLocale();
  // One month shows the days round it; months side by side leave them to the next month.
  const outside = showOutsideDays ?? numberOfMonths === 1;
  return (
    <CalendarPrimitive
      {...rest}
      locale={locale ?? pageLocale}
      months={numberOfMonths}
      showOutsideDays={outside}
      render={<div data-slot="calendar" />}
      {...stylex.props(styles.root, style)}
    >
      <CalendarMonths numberOfMonths={numberOfMonths} />
    </CalendarPrimitive>
  );
};
