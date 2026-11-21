// ItemGrid: Items as tiles, as many per row as fit (an app's tiles on an Integrations page): each
// tile at least item-grid-tile wide, the row's tiles sharing its width and one height. A real list,
// so a screen reader says how many there are, and the keys go through it in reading order, row by
// row. The Items in it are small outlined tiles: a mark, a name and one line.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { grasp } from "../tokens/tokens.stylex";
import { ItemGroupContext } from "./context";

/** Every prop an ItemGrid takes. */
export interface ItemGridProps {
  /** The Items, in the order they are read: row by row, from the start. */
  children: ReactNode;
  /** What the list holds, when no heading above it says ("Connected apps"). */
  "aria-label"?: string;
  /** The id of a heading that names it, in place of `aria-label`. */
  "aria-labelledby"?: string;
}

const styles = stylex.create({
  grid: {
    display: "grid",
    // As many as fit, never under the tile's least width, and one whole column on a narrow page.
    gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${grasp.itemGridTile}), 1fr))`,
    gap: grasp.space3,
    width: "100%",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
});

/** Items as tiles, as many per row as fit. */
export const ItemGrid = ({
  children,
  "aria-label": label,
  "aria-labelledby": labelledBy,
}: ItemGridProps) => (
  // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
  <ItemGroupContext.Provider value={{ grouped: true, separated: false }}>
    <ul
      // oxlint-disable-next-line jsx-a11y/no-redundant-roles -- Safari drops a list's role once its markers are hidden
      role="list"
      aria-label={label}
      aria-labelledby={labelledBy}
      data-slot="item-grid"
      {...stylex.props(styles.grid)}
    >
      {children}
    </ul>
  </ItemGroupContext.Provider>
);
