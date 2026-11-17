// CalendarMonths: the inside of a calendar (calendar.tsx) and of a date picker's popup
// (src/components/date-picker): Previous, the month's name and Next, then a grid of days for each
// month shown. It reads the nearest UI SDK calendar, so it works in either.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
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
import type { ReactNode } from "react";

import { Button } from "../button";
import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { ChevronLeft, ChevronRight } from "../icons";
import { calendarStyles as styles } from "./styles";

interface CalendarMonthsProps {
  months: number;
  previousLabel: string;
  nextLabel: string;
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

/** Previous, the month's name and Next, then the days of each month shown. */
export const CalendarMonths = ({
  months,
  previousLabel,
  nextLabel,
}: CalendarMonthsProps) => {
  const dayLook = stylex.props(styles.day, focus.mark);
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
              size="sm"
              icon={ChevronLeft}
              aria-label={previousLabel}
            />
          )}
        />
        <HeadingPrimitive
          {...stylex.props(
            styles.heading,
            stacked && months > 1 && styles.headingStacked
          )}
        />
        <NextPrimitive
          render={({
            children: _children,
            ...props
          }: Record<string, unknown>) => (
            <Button
              {...props}
              variant="ghost"
              size="sm"
              icon={ChevronRight}
              aria-label={nextLabel}
            />
          )}
        />
      </div>
      <div ref={setRow} {...stylex.props(styles.months)}>
        {Array.from({ length: months }, (_, offset) => (
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
