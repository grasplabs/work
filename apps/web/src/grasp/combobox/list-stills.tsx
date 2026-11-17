// ListStills: a row of list items standing still, each with its state's name above it, for the
// docs' every-state rows (list-still.tsx). Docs only.
import * as stylex from "@stylexjs/stylex";

import { grasp } from "../tokens/tokens.stylex";
import { ListItemStill } from "./list-still";
import type { ListItemStillProps } from "./list-still";

export interface ListStillsProps {
  /** One item per state, with the state's name. */
  cells: (ListItemStillProps & { name: string })[];
}

const styles = stylex.create({
  grid: {
    display: "grid",
    gridTemplateColumns: `repeat(auto-fill, minmax(min(${grasp.popupWidth}, 100%), 1fr))`,
    alignItems: "start",
    gap: grasp.space6,
    width: "100%",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // One column that can narrow to the cell, so a still never pushes past a narrow window.
  cell: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    justifyItems: "center",
    rowGap: grasp.space3,
  },
  name: {
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
});

export const ListStills = ({ cells }: ListStillsProps) => (
  <ul data-state-stills="" {...stylex.props(styles.grid)}>
    {cells.map(({ name, ...cell }) => (
      <li key={name} {...stylex.props(styles.cell)}>
        <span data-state-caption="" {...stylex.props(styles.name)}>
          {name}
        </span>
        <ListItemStill {...cell} />
      </li>
    ))}
  </ul>
);
