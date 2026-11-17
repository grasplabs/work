// RowList: a card's list of things, one 44px row each, after the rows of Profound's agent panel: a
// small icon in the one accent that says what kind of thing it is, its name, an optional mark
// (a lock on one that cannot change), a quiet detail, and its actions at the end, which show under
// a pointer when the row is hovered or holds focus, and always on touch and for the keyboard.
// Rows are all one height, with a hairline between them and clear space on both sides of it.
//
//   <RowList aria-label="Tools">
//     <RowListItem icon={Web} name="Search the web" actions={<RowListAction icon={Trash} label="Remove Search the web" />} />
//     <RowListItem icon={Database} name="Customer records" mark={<Icon icon={Lock} label="Fixed" />} />
//   </RowList>
//
// Why not ItemGroup: an Item pads 16px and sets its icon in a 36px square, grows with its
// description, and keeps its actions in view; an inspector's card needs 12px, a bare 16px icon,
// one height for every row, and actions that wait for the pointer.
//
// Every value is a token (src/tokens).
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { styles } from "./styles";

/** Every prop a RowList takes. */
export interface RowListProps {
  /** Its rows: RowListItem, and a RowListAdd last when more can be added. */
  children: ReactNode;
  /** What the list holds, when no label above it says ("Tools"). */
  "aria-label"?: string;
  /** The id of the words that name it, such as a Panel section's label. */
  "aria-labelledby"?: string;
}

/**
 * A list of 44px rows, a hairline between them. The rows draw the lines themselves (every row
 * after the first), and a row without actions keeps their room when the list holds any, by CSS.
 */
export const RowList = ({
  children,
  "aria-label": label,
  "aria-labelledby": labelledBy,
}: RowListProps) => (
  <ul
    aria-label={label}
    aria-labelledby={labelledBy}
    data-slot="row-list"
    {...stylex.props(styles.list)}
  >
    {children}
  </ul>
);
