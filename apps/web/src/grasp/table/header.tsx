// TableHeader: the head of a table (table.tsx), its one row of column names.
"use client";
import type { ReactNode } from "react";

import { SectionContext } from "./section-context";

/** Every prop a TableHeader takes. */
export interface TableHeaderProps {
  /** One TableRow of TableHead cells. */
  children: ReactNode;
}

/** The head of the table: the row that names its columns. */
export const TableHeader = ({ children }: TableHeaderProps) => (
  <thead data-slot="table-header">
    <SectionContext.Provider value="head">{children}</SectionContext.Provider>
  </thead>
);
