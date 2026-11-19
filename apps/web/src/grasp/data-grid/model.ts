// The spreadsheet model, with no React and no DOM: one active cell, one range, the keys that move
// them, TSV in and out, and edits as patches with undo and redo. The grid stores no data: every edit
// leaves as a patch for the caller to apply.

/** A cell by its place in the rows and columns as shown. */
export interface Cell {
  /** The row's index among the rows shown. */
  row: number;
  /** The column's index among the columns shown. */
  col: number;
}

/** The selection: the active cell and the corner the range was dragged or shifted to. */
export interface Selection {
  /** Where typing goes; one end of the range. */
  active: Cell;
  /** The other end of the range; the same as active when one cell is chosen. */
  anchor: Cell;
}

/** The grid's size as shown. */
export interface Extent {
  /** How many rows are shown. */
  rows: number;
  /** How many columns are shown. */
  cols: number;
}

/** A rectangle of cells, both ends included. */
export interface Rect {
  /** The first row. */
  top: number;
  /** The first column. */
  left: number;
  /** The last row. */
  bottom: number;
  /** The last column. */
  right: number;
}

/** What a cell holds: words, a figure, a box's tick, or nothing. */
export type CellValue = string | number | boolean | null;

/** One cell's change, by row and column id so it survives sorting. */
export interface Change {
  /** The row's id. */
  rowId: string;
  /** The column's id. */
  columnId: string;
  /** The value before. */
  from: CellValue;
  /** The value after. */
  to: CellValue;
}

/** One edit as the person made it: a single cell, a paste, a fill or a clear. */
export interface Patch {
  /** What made it, for the announcement and the undo label. */
  kind: "edit" | "paste" | "fill" | "clear" | "cut";
  /** Every cell it changed. */
  changes: Change[];
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), high);

/** A selection of just this cell. */
export const at = (cell: Cell): Selection => ({ active: cell, anchor: cell });

/** The range a selection covers. */
export const rectOf = ({ active, anchor }: Selection): Rect => ({
  top: Math.min(active.row, anchor.row),
  left: Math.min(active.col, anchor.col),
  bottom: Math.max(active.row, anchor.row),
  right: Math.max(active.col, anchor.col),
});

/** Whether a cell lies in the range. */
export const contains = (rect: Rect, { row, col }: Cell) =>
  row >= rect.top &&
  row <= rect.bottom &&
  col >= rect.left &&
  col <= rect.right;

/** Whether the selection is more than one cell. */
export const isRange = (selection: Selection) =>
  selection.active.row !== selection.anchor.row ||
  selection.active.col !== selection.anchor.col;

/** The keys the grid moves on, after the platform's mod (Cmd or Ctrl) is folded in. */
export interface Move {
  /** The key, as KeyboardEvent.key. */
  key: string;
  /** Shift held: grow the range instead of moving. */
  shift?: boolean;
  /** Cmd on Apple, Ctrl elsewhere: jump to the edge. */
  mod?: boolean;
  /** Right to left: the arrows swap sides. */
  rtl?: boolean;
  /** Rows a page holds, for PageUp and PageDown. */
  page?: number;
}

type Step = (from: Cell, extent: Extent, mod: boolean, page: number) => Cell;

// Right to left, the arrows swap sides: read them as the side they point to in the text's flow.
const arrow = (key: string, rtl: boolean) => {
  if (!rtl) {
    return key;
  }
  if (key === "ArrowLeft") {
    return "ArrowRight";
  }
  return key === "ArrowRight" ? "ArrowLeft" : key;
};

const steps: Partial<Record<string, Step>> = {
  ArrowUp: ({ row, col }, _extent, mod) => ({ row: mod ? 0 : row - 1, col }),
  ArrowDown: ({ row, col }, extent, mod) => ({
    row: mod ? extent.rows - 1 : row + 1,
    col,
  }),
  ArrowRight: ({ row, col }, extent, mod) => ({
    row,
    col: mod ? extent.cols - 1 : col + 1,
  }),
  ArrowLeft: ({ row, col }, _extent, mod) => ({ row, col: mod ? 0 : col - 1 }),
  Home: ({ row }, _extent, mod) => ({ row: mod ? 0 : row, col: 0 }),
  End: ({ row }, extent, mod) => ({
    row: mod ? extent.rows - 1 : row,
    col: extent.cols - 1,
  }),
  PageUp: ({ row, col }, _extent, _mod, page) => ({ row: row - page, col }),
  PageDown: ({ row, col }, _extent, _mod, page) => ({ row: row + page, col }),
};

// Tab runs along the row and wraps to the next; Shift+Tab runs back. Never grows a range.
const tab = ({ row, col }: Cell, extent: Extent, back: boolean): Selection => {
  const index = clamp(
    row * extent.cols + col + (back ? -1 : 1),
    0,
    extent.rows * extent.cols - 1
  );
  return at({ row: Math.floor(index / extent.cols), col: index % extent.cols });
};

/**
 * Where a key takes the selection, or null when the key is not a move. Arrows step; mod and an
 * arrow jumps to the edge; Home and End go to the row's ends (with mod, the grid's corners);
 * PageUp and PageDown go a page; Tab and Enter step on and collapse the range. Shift grows the
 * range from the anchor and keeps the active cell's partner still.
 */
export const move = (
  selection: Selection,
  extent: Extent,
  input: Move
): Selection | null => {
  const { key, shift = false } = input;
  if (extent.rows < 1 || extent.cols < 1) {
    return null;
  }
  if (key === "Tab") {
    return tab(selection.active, extent, shift);
  }
  if (key === "Enter") {
    return at({
      row: clamp(selection.active.row + (shift ? -1 : 1), 0, extent.rows - 1),
      col: selection.active.col,
    });
  }
  const step = steps[arrow(key, input.rtl === true)];
  if (step === undefined) {
    return null;
  }
  const to = step(
    selection.active,
    extent,
    input.mod === true,
    input.page ?? 10
  );
  const cell = {
    row: clamp(to.row, 0, extent.rows - 1),
    col: clamp(to.col, 0, extent.cols - 1),
  };
  // Shift moves the far end of the range; the anchor stays.
  return shift ? { active: cell, anchor: selection.anchor } : at(cell);
};

/** Every cell of the grid. */
export const all = (extent: Extent): Selection => ({
  anchor: { row: 0, col: 0 },
  active: {
    row: Math.max(extent.rows - 1, 0),
    col: Math.max(extent.cols - 1, 0),
  },
});

/** Keep a selection inside the grid after rows or columns go. */
export const fit = (selection: Selection, extent: Extent): Selection => {
  const keep = (cell: Cell) => ({
    row: clamp(cell.row, 0, Math.max(extent.rows - 1, 0)),
    col: clamp(cell.col, 0, Math.max(extent.cols - 1, 0)),
  });
  return { active: keep(selection.active), anchor: keep(selection.anchor) };
};

// ---- TSV ------------------------------------------------------------------------------------------
// What spreadsheets put on the clipboard: tabs between cells, newlines between rows, and a cell with
// a tab, a newline or a quote wrapped in quotes with its quotes doubled.

const needsQuotes = /[\t\n\r"]/u;

/** A block of text values as TSV, quoting cells that need it. */
export const toTsv = (block: string[][]): string =>
  block
    .map((line) =>
      line
        .map((text) =>
          needsQuotes.test(text) ? `"${text.replaceAll('"', '""')}"` : text
        )
        .join("\t")
    )
    .join("\n");

// One cell and what ends it: a quoted cell (quotes doubled inside) or a plain one, then a tab, a
// line break or the end.
const tsvCell =
  /(?:"(?<quoted>(?:[^"]|"")*)"|(?<plain>[^\t\n\r]*))(?<end>\t|\r\n|\n|\r|$)/guy;

/** TSV as a block of text values; a trailing newline adds no row. */
export const fromTsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let line: string[] = [];
  tsvCell.lastIndex = 0;
  while (tsvCell.lastIndex < text.length) {
    const found = tsvCell.exec(text);
    if (found?.groups === undefined) {
      break;
    }
    const { quoted, plain = "", end = "" } = found.groups;
    line.push(quoted === undefined ? plain : quoted.replaceAll('""', '"'));
    if (end !== "\t") {
      rows.push(line);
      line = [];
    }
  }
  if (line.length > 0) {
    rows.push(line);
  }
  return rows;
};

/**
 * Where a pasted block lands. One value pasted over a range fills the range; a block pasted over a
 * larger range that it divides evenly tiles it (as spreadsheets do); otherwise the block lands at
 * the range's corner at its own size, cut at the grid's edge.
 */
export const pasteTarget = (
  block: string[][],
  selection: Selection,
  extent: Extent
): { rect: Rect; value: (row: number, col: number) => string } => {
  const height = block.length;
  const width = Math.max(...block.map((line) => line.length), 0);
  const range = rectOf(selection);
  const rangeHeight = range.bottom - range.top + 1;
  const rangeWidth = range.right - range.left + 1;
  const tiles =
    height > 0 &&
    width > 0 &&
    rangeHeight % height === 0 &&
    rangeWidth % width === 0;
  const rect =
    tiles && isRange(selection)
      ? range
      : {
          top: range.top,
          left: range.left,
          bottom: Math.min(range.top + height - 1, extent.rows - 1),
          right: Math.min(range.left + width - 1, extent.cols - 1),
        };
  return {
    rect,
    value: (row, col) =>
      block[(row - rect.top) % height]?.[(col - rect.left) % width] ?? "",
  };
};

// ---- Fill -----------------------------------------------------------------------------------------

/**
 * The range a fill handle drag covers, from the selection to the cell under the pointer: it grows
 * down, up, left or right, whichever way the pointer went furthest, never both.
 */
export const fillRect = (selection: Selection, to: Cell): Rect => {
  const rect = rectOf(selection);
  const down = to.row - rect.bottom;
  const up = rect.top - to.row;
  const right = to.col - rect.right;
  const left = rect.left - to.col;
  const vertical = Math.max(down, up);
  const horizontal = Math.max(right, left);
  if (vertical <= 0 && horizontal <= 0) {
    return rect;
  }
  if (vertical >= horizontal) {
    return down > 0 ? { ...rect, bottom: to.row } : { ...rect, top: to.row };
  }
  return right > 0 ? { ...rect, right: to.col } : { ...rect, left: to.col };
};

/**
 * The value a filled cell takes. Numbers that step evenly carry the step on (1, 2 fills 3, 4);
 * anything else repeats the source in order.
 */
export const fillValue = (source: CellValue[], index: number): CellValue => {
  const numbers = source.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value)
  );
  const [first, second] = numbers;
  const last = numbers.at(-1);
  if (
    numbers.length === source.length &&
    first !== undefined &&
    second !== undefined &&
    last !== undefined
  ) {
    const step = second - first;
    const even = numbers.every(
      (value, i) => i === 0 || value - (numbers[i - 1] ?? value) === step
    );
    if (even) {
      return last + step * (index - numbers.length + 1);
    }
  }
  return (
    source[((index % source.length) + source.length) % source.length] ?? null
  );
};

// ---- Undo -----------------------------------------------------------------------------------------

/** The edits made, to step back and forward through. */
export interface History {
  /** Patches that undo can take back, oldest first. */
  done: Patch[];
  /** Patches that redo can put back, most recent undo last. */
  undone: Patch[];
}

/** An empty history. */
export const history = (): History => ({ done: [], undone: [] });

/** The history after a new patch: it can be undone, and nothing can be redone. */
export const record = (state: History, patch: Patch, limit = 200): History => ({
  done: [...state.done, patch].slice(-limit),
  undone: [],
});

/** A patch run backwards. */
export const invert = (patch: Patch): Patch => ({
  kind: patch.kind,
  changes: patch.changes.toReversed().map(({ rowId, columnId, from, to }) => ({
    rowId,
    columnId,
    from: to,
    to: from,
  })),
});

/** The patch that undoes the latest edit (from and to swapped), and the history after it. */
export const undo = (
  state: History
): { patch: Patch; state: History } | null => {
  const last = state.done.at(-1);
  if (last === undefined) {
    return null;
  }
  return {
    patch: invert(last),
    state: { done: state.done.slice(0, -1), undone: [...state.undone, last] },
  };
};

/** The patch that redoes the latest undo, and the history after it. */
export const redo = (
  state: History
): { patch: Patch; state: History } | null => {
  const last = state.undone.at(-1);
  if (last === undefined) {
    return null;
  }
  return {
    patch: last,
    state: { done: [...state.done, last], undone: state.undone.slice(0, -1) },
  };
};
