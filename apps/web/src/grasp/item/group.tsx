// ItemGroup: a list of Items (item.tsx), one per row, with the page's hairline between them when
// they are plain. A real list, so a screen reader says how many there are.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { grasp } from "../tokens/tokens.stylex";
import { ItemGroupContext } from "./context";

/** Every prop an ItemGroup takes. */
export interface ItemGroupProps {
  /** The Items, in the order they are read. */
  children: ReactNode;
  /**
   * A hairline between rows, for plain items in a long list. Outlined or soft items stand apart
   * by a gap instead.
   * @default false
   */
  separated?: boolean;
  /** What the list holds, when no heading above it says ("Recent projects"). */
  "aria-label"?: string;
}

const styles = stylex.create({
  list: {
    display: "grid",
    width: "100%",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  apart: { gap: grasp.space2 },
  lined: { rowGap: grasp.space1 },
});

/** A list of Items. */
// Each Item in it stands in its own row (<li>), with the hairline over it when separated.
export const ItemGroup = ({
  children,
  separated = false,
  "aria-label": label,
}: ItemGroupProps) => (
  // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
  <ItemGroupContext.Provider value={{ grouped: true, separated }}>
    <ul
      // oxlint-disable-next-line jsx-a11y/no-redundant-roles -- Safari drops a list's role once its markers are hidden
      role="list"
      aria-label={label}
      data-slot="item-group"
      {...stylex.props(styles.list, separated ? styles.lined : styles.apart)}
    >
      {children}
    </ul>
  </ItemGroupContext.Provider>
);
