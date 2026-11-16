// TableBody: the rows of a table (table.tsx).
"use client";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { arrive } from "../motion/arrive";
import { SectionContext } from "./section-context";

/** Every prop a TableBody takes. */
export interface TableBodyProps {
  /** The rows: one TableRow for each thing the table lists. */
  children: ReactNode;
  /**
   * The rows have just replaced their placeholders: they fade in where those stood, and nothing
   * moves. Leave it off on the first paint.
   * @default false
   */
  arrived?: boolean;
}

/** The rows of the table. A row is lit under a pointer. */
export const TableBody = ({ children, arrived = false }: TableBodyProps) => (
  <tbody data-slot="table-body" {...stylex.props(arrived && arrive.in)}>
    <SectionContext.Provider value="body">{children}</SectionContext.Provider>
  </tbody>
);
