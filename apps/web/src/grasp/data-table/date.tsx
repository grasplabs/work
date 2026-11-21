// A date column for a Data table: the words people say ("3 hours ago", "Yesterday", then the day)
// in the reader's language, the full date and time in a tooltip on hover and on focus, and the
// date itself in a <time datetime> so it is there with scripts off. It sorts by the date, not by
// the words; a missing date is a quiet dash, last in the order.
//
//   dateColumn({ key: "updated", header: "Updated", date: (row) => row.updatedAt })
//
// The words tick over once a minute (src/when) in a box as wide as the widest they can be, so the
// row never moves; they stay the server's on the first paint and change at the first tick.
"use client";

import * as stylex from "@stylexjs/stylex";

import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { grasp } from "../tokens/tokens.stylex";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import { useNow, when, widestWords } from "../when/when";
import { useWords, useWordsLocale } from "../words/words";
import type { DataTableColumn } from "./types";
import { dataTableWords } from "./words";

/** A date as a row gives it: a Date, an ISO string or a time in milliseconds; none, no date. */
export type DataTableDate = Date | string | number | null | undefined;

/** Everything a date column takes: a column's own props, and where its date is. */
export interface DataTableDateColumn<Row> extends Omit<
  DataTableColumn<Row>,
  "value" | "cell" | "filter"
> {
  /** The row's date. */
  date: (row: Row) => DataTableDate;
}

const styles = stylex.create({
  // As wide as the widest words, so the row stays put as they tick over.
  room: (width: string) => ({ display: "inline-block", minWidth: width }),
  // The words themselves, the focus ring snug round them.
  time: {
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    borderRadius: grasp.cornerMark,
  },
  none: { color: grasp.muted },
});

/** The date as a Date, or nothing when there is none or it does not read as one. */
const dateOf = (given: DataTableDate): Date | null => {
  const date =
    given === null || given === undefined || given === ""
      ? new Date(Number.NaN)
      : new Date(given);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** A date cell: its words, the full date in a tooltip, or a quiet dash with none. */
export const DataTableDateCell = ({ date: given }: { date: DataTableDate }) => {
  const locale = useWordsLocale();
  const now = useNow();
  const { noDate } = useWords("dataTable", dataTableWords);
  const date = dateOf(given);
  if (date === null) {
    return (
      <span data-slot="data-table-date">
        <span aria-hidden="true" {...stylex.props(styles.none)}>
          —
        </span>
        <span {...stylex.props(visuallyHidden)}>{noDate}</span>
      </span>
    );
  }
  const { words, full } = when(date, now, locale);
  return (
    <span {...stylex.props(styles.room(`${widestWords(locale)}ch`))}>
      <Tooltip>
        <TooltipTrigger
          // It takes focus, so the keys reach its tooltip as a pointer does.
          tabIndex={0}
          render={
            // The server's words stay on the first paint; the first tick brings the reader's.
            <time
              dateTime={date.toISOString()}
              data-slot="data-table-date"
              suppressHydrationWarning
              {...stylex.props(styles.time, focus.words)}
            />
          }
        >
          {words}
        </TooltipTrigger>
        <TooltipContent>{full}</TooltipContent>
      </Tooltip>
    </span>
  );
};

/** A Data table column of dates: sorted by the date, drawn as words with the full date to hand. */
export const dateColumn = <Row,>({
  date,
  ...column
}: DataTableDateColumn<Row>): DataTableColumn<Row> => ({
  ...column,
  // By the date; a missing one last whichever way the order runs is not possible with one number,
  // so it sorts as the earliest: last when newest comes first, as a date column usually starts.
  value: (row) => dateOf(date(row))?.getTime() ?? Number.NEGATIVE_INFINITY,
  cell: (row) => <DataTableDateCell date={date(row)} />,
  filter: false,
});
