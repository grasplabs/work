// TableFooter: the sums of a table (table.tsx), on the soft ground.
"use client";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { SectionContext } from "./section-context";
import { tableStyles as styles } from "./styles";

/** Every prop a TableFooter takes. */
export interface TableFooterProps {
  /** One TableRow: a total or a count for the rows above. */
  children: ReactNode;
}

/** The footer: a total or a count, on the soft ground, in ink. */
export const TableFooter = ({ children }: TableFooterProps) => (
  <tfoot data-slot="table-footer" {...stylex.props(styles.footer)}>
    <SectionContext.Provider value="foot">{children}</SectionContext.Provider>
  </tfoot>
);
