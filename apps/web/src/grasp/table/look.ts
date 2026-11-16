// The table's look, where Ruben is still choosing (the fixture: examples/data-table/looks.tsx).
// His choice is one line: the defaults below. A table can also take another look as a prop.
// Provisional: the Data grid's wash on chosen rows and its soft head, so Table, Data table and Data
// grid read as one family.
import { createContext, useContext } from "react";

/** How a chosen row shows: today's grey band, a soft mint wash, or the grey band with a pine bar. */
export type TableRangeLook = "grey" | "mint" | "bar";
/**
 * How the head shows: as now (muted names on the ground), on the soft ground, or quiet with a pine
 * line under a sorted name and its place in a mint chip.
 */
export type TableHeadLook = "plain" | "soft" | "quiet";

/** The look every table takes unless it is given another. */
export const tableLook: { range: TableRangeLook; head: TableHeadLook } = {
  range: "mint",
  head: "soft",
};

export const RangeLookContext = createContext<TableRangeLook>(tableLook.range);
export const HeadLookContext = createContext<TableHeadLook>(tableLook.head);
export const useRangeLook = () => useContext(RangeLookContext);
export const useHeadLook = () => useContext(HeadLookContext);
