// Which part of a table a row stands in, so a row in the body can light under a pointer and leave
// its last hairline to the footer, while a row in the head does neither.
import { createContext, useContext } from "react";

export const SectionContext = createContext<"head" | "body" | "foot">("body");
export const useSection = () => useContext(SectionContext);

/** How much room a row has: `compact` 32px, `default` 42px, `roomy` 50px. The words stay the same. */
export type TableDensity = "compact" | "default" | "roomy";

// What the whole table says to its cells: its density, and whether its head stays in view. Two
// plain values, each in its own context, so no object is built for them on every render.
export const DensityContext = createContext<TableDensity>("default");
export const StickyHeadContext = createContext(false);
export const useDensity = () => useContext(DensityContext);
export const useStickyHead = () => useContext(StickyHeadContext);

/**
 * A column held in place while the rest scrolls sideways: at the `start` or the `end`, `offset`
 * from that edge (a CSS length: the widths of the held columns before it). `edge` marks the one
 * nearest the scrolling columns: it casts the low lift while something is scrolled under it.
 */
export interface TablePin {
  side: "start" | "end";
  offset: string;
  edge?: boolean;
  /** Drawn above the held cells after it, which its control's reach spills into (a checkbox). */
  above?: boolean;
}
