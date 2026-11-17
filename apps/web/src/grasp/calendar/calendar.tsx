// Calendar: a month of days to choose one date, several, or a range from, from shadcn's
// (registry/bases/base/ui/calendar.tsx, on react-day-picker), rebuilt on UI SDK's Calendar and made
// Grasp's: small type, the month's name between Previous and Next (ghost Buttons), weekdays in
// muted words, and days the size of a small control. A chosen day takes the first action's colour;
// a range joins its days in a quiet band. Palermo has no calendar, so the look follows Grasp's
// Select and Button.
//
//   <Calendar defaultValue="2026-11-16" />
//   <Calendar mode="range" defaultValue={["2026-11-10", "2026-11-14"]} months={2} />
//
// Dates are ISO strings ("2026-11-16"), with no time or time zone. The arrow keys move through the
// days, Page Up and Page Down through the months. Every value is a token (src/tokens).
"use client";

import * as stylex from "@stylexjs/stylex";
import { Calendar as CalendarPrimitive } from "@ui-sdk/react/calendar";
import type { ComponentProps } from "react";

import { CalendarMonths } from "./months";
import { calendarStyles as styles } from "./styles";

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
   * How many dates it chooses: `single` one, `multiple` any number, `range` a start and an end.
   * @default "single"
   */
  mode?: RootProps["mode"];
  /**
   * The chosen value: an ISO date for `single`, a list for `multiple`, `[start, end]` for
   * `range`, or `null`. Pass it with `onValueChange` to hold the value yourself.
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
  months?: number;
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
   * The name of the Previous button, in the page's language.
   * @default "Previous month"
   */
  previousLabel?: string;
  /**
   * The name of the Next button, in the page's language.
   * @default "Next month"
   */
  nextLabel?: string;
  /**
   * Whether the days of the months before and after show at the grid's edges, in a quieter colour.
   * Shown for one month; with two or more side by side the next month shows those days itself.
   * @default true for one month, false for more
   */
  showOutsideDays?: boolean;
}

/** A month of days to choose from, with Previous and Next. */
export const Calendar = ({
  months = 1,
  previousLabel,
  nextLabel,
  showOutsideDays,
  ...rest
}: CalendarProps) => {
  // One month shows the days round it; months side by side leave them to the next month.
  const outside = showOutsideDays ?? months === 1;
  return (
    <CalendarPrimitive
      {...rest}
      months={months}
      showOutsideDays={outside}
      {...stylex.props(styles.root)}
    >
      <CalendarMonths
        months={months}
        previousLabel={previousLabel}
        nextLabel={nextLabel}
      />
    </CalendarPrimitive>
  );
};
