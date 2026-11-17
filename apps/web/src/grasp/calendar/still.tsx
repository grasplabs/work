// CalendarDayStill: one day of a calendar, for the docs' every-state row only. It is a real UI SDK
// Calendar, with the Calendar's own day styles (styles.ts), that draws a single day: so a state
// (chosen, today, inside a range, another month's, unavailable, disabled) is what the Calendar
// itself shows. Not part of the component: never in a product, and not exported from index.ts.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Calendar as CalendarPrimitive,
  CalendarDay as DayPrimitive,
  CalendarGrid as GridPrimitive,
  CalendarWeeks as WeeksPrimitive,
} from "@ui-sdk/react/calendar";
import type { ComponentProps } from "react";

import { focus } from "../focus/focus";
import { calendarStyles as styles } from "./styles";

type RootProps = ComponentProps<typeof CalendarPrimitive>;

export interface CalendarDayStillProps {
  /** The day drawn, as an ISO date. */
  date: string;
  /** The month the grid shows: a day from another month is drawn as one. */
  month: string;
  /** Today, so a day can be drawn as today, or not. */
  today: string;
  mode?: RootProps["mode"];
  value?: RootProps["value"];
  min?: string;
  unavailable?: RootProps["unavailable"];
  /** The grid's name, for a screen reader. @default "Day" */
  label?: string;
}

/** One day of a calendar, standing still. */
export const CalendarDayStill = ({
  date,
  month,
  today,
  mode = "single",
  value = null,
  min,
  unavailable,
  label = "Day",
}: CalendarDayStillProps) => {
  const look = stylex.props(styles.day, focus.mark);
  return (
    <CalendarPrimitive
      mode={mode}
      value={value}
      month={month}
      today={today}
      min={min}
      unavailable={unavailable}
      showOutsideDays
      {...stylex.props(styles.root)}
    >
      <GridPrimitive aria-label={label} {...stylex.props(styles.grid)}>
        <WeeksPrimitive>
          {(cell) =>
            cell.date === date ? (
              <DayPrimitive value={cell.date} {...look} />
            ) : null
          }
        </WeeksPrimitive>
      </GridPrimitive>
    </CalendarPrimitive>
  );
};
