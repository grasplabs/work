// TableCell: one fact in a row of a table (table.tsx).
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { pinLook, placeOf } from "./head";
import { useRangeLook } from "./look";
import { useDensity } from "./section-context";
import type { TablePin } from "./section-context";
import { tableStyles as styles } from "./styles";

/** Every prop a TableCell takes. */
export interface TableCellProps {
  /** The fact: words, a figure, or a small control. */
  children?: ReactNode;
  /**
   * Where it stands: `end` for figures, so their units line up; `center` for short marks.
   * @default "start"
   */
  align?: "start" | "center" | "end";
  /**
   * The cell that says what the row is, usually the first: in ink, and read as
   * the row's name by a screen reader.
   * @default false
   */
  lead?: boolean;
  /**
   * How many columns it spans, as in a footer's "Total" label.
   * @default 1
   */
  colSpan?: number;
  /** Held in place while the other columns scroll sideways (a Data table's pinned column). */
  pin?: TablePin;
  /**
   * Its words stop at the column's edge with an ellipsis, in a table whose columns are sized. Give
   * the whole text as `title`, so what the ellipsis hides can still be read.
   * @default false
   */
  clip?: boolean;
  /** The cell's whole text, shown on hover where `clip` cuts it short. */
  title?: string;
  /**
   * Its words may wrap onto more lines: a cell that holds a sentence. Only the lead cell wraps by
   * itself; every other cell (a figure, a date, a name, a badge) stays on one line, and a table
   * too narrow for its rows scrolls sideways inside its box.
   * @default false
   */
  wrap?: boolean;
}

/** One fact in a row. The row's lead cell names the row. */
export const TableCell = ({
  children,
  align = "start",
  lead = false,
  colSpan,
  pin,
  clip = false,
  title,
  wrap = false,
}: TableCellProps) => {
  const density = useDensity();
  const range = useRangeLook();
  const look = stylex.props(
    styles.cell,
    density === "compact" && styles.compact,
    density === "roomy" && styles.roomy,
    lead && styles.lead,
    !lead && !wrap && styles.oneLine,
    align === "end" && styles.end,
    align === "center" && styles.centre,
    clip && styles.clip,
    pinLook(pin),
    pin !== undefined && range === "mint" && styles.pinnedMint,
    pin?.above === true && styles.aboveBody,
    placeOf(pin)
  );
  if (lead) {
    return (
      <th
        data-slot="table-cell"
        scope="row"
        colSpan={colSpan}
        title={clip ? title : undefined}
        {...look}
      >
        {children}
      </th>
    );
  }
  return (
    <td
      data-slot="table-cell"
      colSpan={colSpan}
      title={clip ? title : undefined}
      {...look}
    >
      {children}
    </td>
  );
};
