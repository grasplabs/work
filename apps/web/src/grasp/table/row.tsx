// TableRow: one row of a table (table.tsx), with a hairline under it.
"use client";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { useRangeLook } from "./look";
import { useSection } from "./section-context";
import { tableStyles as styles } from "./styles";

/** Every prop a TableRow takes. */
export interface TableRowProps {
  /** The row's cells: TableHead in the head, TableCell everywhere else. */
  children: ReactNode;
  /**
   * The row is chosen, for instance by a checkbox in its first cell: it keeps a quiet fill. Say it
   * in the row as well; the fill alone is not enough.
   * @default false
   */
  chosen?: boolean;
  /**
   * Kept for its widths only: not drawn, not read, not reached, while the columns keep the sizes
   * it gives them (a Data table keeps its rows so while a search matches none, so the columns do
   * not jump as you type).
   * @default false
   */
  collapsed?: boolean;
}

/** A row, with a hairline under it. In the body it is lit under a pointer. */
export const TableRow = ({
  children,
  chosen = false,
  collapsed = false,
}: TableRowProps) => {
  const section = useSection();
  const range = useRangeLook();
  return (
    <tr
      data-slot="table-row"
      data-state={chosen ? "selected" : undefined}
      aria-hidden={collapsed || undefined}
      inert={collapsed || undefined}
      {...stylex.props(
        collapsed && styles.collapsed,
        styles.row,
        section === "body" && styles.bodyRow,
        chosen && styles.chosen,
        chosen && range === "mint" && styles.chosenMint,
        chosen && range === "bar" && styles.chosenBar
      )}
    >
      {children}
    </tr>
  );
};
