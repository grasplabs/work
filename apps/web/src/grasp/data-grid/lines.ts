// Which of a cell's two hairlines (at its end, and below it) lie on the chosen range's edge. The
// edge is drawn on the hairlines themselves, so the cell before the range and the row above it
// carry its start and its top: the head row is row -1, the row numbers are column -1.
import type { Cell, Rect } from "./model";
import type { DataGridActiveLook, DataGridRangeLook } from "./types";

/** What is chosen and how it is drawn. */
export interface Drawn {
  /** The range chosen; one cell when nothing more is. */
  rect: Rect;
  /** The active cell. */
  cell: Cell;
  /** Whether it is more than one cell. */
  ranged: boolean;
  /** The active cell's look. */
  active: DataGridActiveLook;
  /** The range's look. */
  range: DataGridRangeLook;
  /** The grid holds the focus: only then is the active cell drawn (the model keeps it either way). */
  focused: boolean;
}

/** A cell's lines on the edge. */
export interface Lines {
  /** The hairline at its end. */
  end: boolean;
  /** The hairline below it. */
  below: boolean;
}

const none: Lines = { end: false, below: false };

const around = (rect: Rect, row: number, col: number): Lines => ({
  end:
    row >= rect.top &&
    row <= rect.bottom &&
    (col === rect.right || col === rect.left - 1),
  below:
    col >= rect.left &&
    col <= rect.right &&
    (row === rect.bottom || row === rect.top - 1),
});

/** The lines of the cell at a row and column that carry the edge. */
export const linesAt = (
  { rect, cell, ranged, active, focused }: Drawn,
  row: number,
  col: number
): Lines => {
  const own = around(
    { top: cell.row, bottom: cell.row, left: cell.col, right: cell.col },
    row,
    col
  );
  if (!ranged) {
    // One cell, lifted: it draws its own edge and leaves the sheet's lines alone. With no focus in
    // the grid the active cell draws nothing at all: a grid nobody is in is calm.
    if (active === "lifted" || !focused) {
      return none;
    }
    // One cell, underlined: the line below it alone. With the halo: the four lines round it.
    return active === "underline"
      ? { end: false, below: own.below && row === cell.row }
      : own;
  }
  const range = around(rect, row, col);
  // In a range the halo's cell keeps its own four lines, beside the range's edge.
  return active === "halo" && focused
    ? { end: range.end || own.end, below: range.below || own.below }
    : range;
};

/** The sides of a cell inside the range that lie on its edge, for the firmer edge's second line. */
export const sidesAt = (rect: Rect, row: number, col: number) => ({
  top: row === rect.top,
  bottom: row === rect.bottom,
  start: col === rect.left,
  end: col === rect.right,
});
