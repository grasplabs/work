// The spreadsheet's rules, with no React and no DOM: its columns and values, one active cell and
// one range, the keys that move them, TSV in and out, how typed words become values, the sort, and
// edits as patches with undo and redo. The grid stores no data: every edit leaves as a patch.
import type { IconData } from "../../lib/icons";

/** What a column holds: it sets the cell's look, its editor and how typed or pasted words are read. */
export type DataGridColumnType =
  | "text"
  | "number"
  | "currency"
  | "select"
  | "date"
  | "person"
  | "boolean";

/** What a cell holds: words, a figure, a box's tick, or nothing. */
export type DataGridCellValue = string | number | boolean | null;

/** One column: what it is called, what it holds, and how it shows. */
export interface DataGridColumn<Row> {
  /** A short, unique name for the column in code ("budget"). */
  key: string;
  /** The column's name in its head, short and in sentence case. */
  header: string;
  /** What it holds. */
  type: DataGridColumnType;
  /** The row's value in this column: what it shows, sorts by, copies and edits. */
  value: (row: Row) => DataGridCellValue;
  /** How the value shows, when the type's own way is not enough. */
  format?: (value: DataGridCellValue) => string;
  /** A select's values: typed or pasted words must be one of them. */
  options?: readonly string[];
  /** Its cells cannot be edited. @default false */
  readOnly?: boolean;
  /** Its name can be pressed to sort the rows by it. @default false */
  sortable?: boolean;
  /** Its share of spare room beside the other columns. @default 1 */
  flex?: number;
  /** An icon for its head, in place of its type's. */
  icon?: IconData;
}

/** A cell by its place in the rows and columns as shown. */
export interface DataGridCell {
  /** The row's index among the rows shown. */
  row: number;
  /** The column's index among the columns shown. */
  col: number;
}

/** The selection: the active cell and the corner the range was dragged or shifted to. */
export interface DataGridSelection {
  /** Where typing goes; one end of the range. */
  active: DataGridCell;
  /** The other end of the range; the same as active when one cell is chosen. */
  anchor: DataGridCell;
}

/** One cell's change, by row and column id so it survives sorting. */
export interface DataGridChange {
  /** The row's id. */
  rowId: string;
  /** The column's key. */
  columnId: string;
  /** The value before. */
  from: DataGridCellValue;
  /** The value after. */
  to: DataGridCellValue;
}

/** One edit as the person made it: a single cell, a paste, a clear or a cut. */
export interface DataGridPatch {
  /** What made it. */
  kind: "edit" | "paste" | "clear" | "cut";
  /** Every cell it changed. */
  changes: DataGridChange[];
}

/** The grid's size as shown. */
export interface Extent {
  rows: number;
  cols: number;
}

/** A rectangle of cells, both ends included. */
export interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** The rows after a patch, for rows kept as objects keyed by the columns' keys. */
export const applyDataGridPatch = <Row extends object>(
  rows: readonly Row[],
  patch: DataGridPatch,
  getRowId: (row: Row) => string
): Row[] => {
  const byRow = new Map<string, Record<string, DataGridCellValue>>();
  for (const { rowId, columnId, to } of patch.changes) {
    byRow.set(rowId, { ...byRow.get(rowId), [columnId]: to });
  }
  return rows.map((row) => {
    const changes = byRow.get(getRowId(row));
    return changes === undefined ? row : { ...row, ...changes };
  });
};

// ---- The selection and the keys ----------------------------------------------------------------

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), high);

/** A selection of just this cell. */
export const at = (cell: DataGridCell): DataGridSelection => ({
  active: cell,
  anchor: cell,
});

/** The range a selection covers. */
export const rectOf = ({ active, anchor }: DataGridSelection): Rect => ({
  top: Math.min(active.row, anchor.row),
  left: Math.min(active.col, anchor.col),
  bottom: Math.max(active.row, anchor.row),
  right: Math.max(active.col, anchor.col),
});

/** Whether a cell lies in the range. */
export const contains = (rect: Rect, { row, col }: DataGridCell) =>
  row >= rect.top &&
  row <= rect.bottom &&
  col >= rect.left &&
  col <= rect.right;

/** Whether the selection is more than one cell. */
export const isRange = ({ active, anchor }: DataGridSelection) =>
  active.row !== anchor.row || active.col !== anchor.col;

/** Every cell of a rectangle, row by row. */
export const cellsOf = (rect: Rect): DataGridCell[] =>
  Array.from({ length: rect.bottom - rect.top + 1 }, (_, row) =>
    Array.from({ length: rect.right - rect.left + 1 }, (__, col) => ({
      row: rect.top + row,
      col: rect.left + col,
    }))
  ).flat();

/** Every cell of the grid. */
export const all = (extent: Extent): DataGridSelection => ({
  anchor: { row: 0, col: 0 },
  active: {
    row: Math.max(extent.rows - 1, 0),
    col: Math.max(extent.cols - 1, 0),
  },
});

/** Keep a selection inside the grid after rows or columns go. */
export const fit = (
  selection: DataGridSelection,
  extent: Extent
): DataGridSelection => {
  const keep = (cell: DataGridCell) => ({
    row: clamp(cell.row, 0, Math.max(extent.rows - 1, 0)),
    col: clamp(cell.col, 0, Math.max(extent.cols - 1, 0)),
  });
  return { active: keep(selection.active), anchor: keep(selection.anchor) };
};

/** A key the grid moves on, with the platform's mod (Cmd or Ctrl) folded in. */
export interface Move {
  key: string;
  /** Shift held: grow the range instead of moving. */
  shift: boolean;
  /** Cmd on Apple, Ctrl elsewhere: jump to the edge. */
  mod: boolean;
  /** Right to left: the arrows swap sides. */
  rtl: boolean;
}

/** The rows PageUp and PageDown move. */
const PAGE = 10;

type Step = (from: DataGridCell, extent: Extent, mod: boolean) => DataGridCell;

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
  PageUp: ({ row, col }) => ({ row: row - PAGE, col }),
  PageDown: ({ row, col }) => ({ row: row + PAGE, col }),
};

// Right to left, the arrows swap sides: read them as the side they point to in the text's flow.
const flowOf = (key: string, rtl: boolean) => {
  if (rtl && key === "ArrowLeft") {
    return "ArrowRight";
  }
  return rtl && key === "ArrowRight" ? "ArrowLeft" : key;
};

/**
 * Where a key takes the selection, or null when the key is not a move. Arrows step; mod and an
 * arrow jumps to the edge; Home and End go to the row's ends (with mod, the grid's corners);
 * PageUp and PageDown go a page. Tab runs along the row and wraps (Shift back), Enter steps down
 * (Shift up), and both collapse the range. Shift grows the range from the anchor.
 */
export const move = (
  selection: DataGridSelection,
  extent: Extent,
  { key, shift, mod, rtl }: Move
): DataGridSelection | null => {
  if (extent.rows < 1 || extent.cols < 1) {
    return null;
  }
  const { row, col } = selection.active;
  if (key === "Tab") {
    const index = clamp(
      row * extent.cols + col + (shift ? -1 : 1),
      0,
      extent.rows * extent.cols - 1
    );
    return at({
      row: Math.floor(index / extent.cols),
      col: index % extent.cols,
    });
  }
  if (key === "Enter") {
    return at({ row: clamp(row + (shift ? -1 : 1), 0, extent.rows - 1), col });
  }
  const step = steps[flowOf(key, rtl)];
  if (step === undefined) {
    return null;
  }
  const to = step(selection.active, extent, mod);
  const cell = {
    row: clamp(to.row, 0, extent.rows - 1),
    col: clamp(to.col, 0, extent.cols - 1),
  };
  return shift ? { active: cell, anchor: selection.anchor } : at(cell);
};

// ---- TSV ---------------------------------------------------------------------------------------
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
  // Text that ends on a tab ends on an empty cell.
  if (line.length > 0) {
    rows.push([...line, ""]);
  }
  return rows;
};

/**
 * Where a pasted block lands. A block pasted over a larger range that it divides evenly tiles it
 * (one value fills it), as spreadsheets do; otherwise the block lands at the range's corner at its
 * own size, cut at the grid's edge.
 */
export const pasteTarget = (
  block: string[][],
  selection: DataGridSelection,
  extent: Extent
): { rect: Rect; value: (row: number, col: number) => string } => {
  const height = block.length;
  // A loop, not a spread: spread, a very large paste's lines overflow the call stack.
  let width = 0;
  for (const line of block) {
    width = Math.max(width, line.length);
  }
  const range = rectOf(selection);
  const tiles =
    height > 0 &&
    width > 0 &&
    (range.bottom - range.top + 1) % height === 0 &&
    (range.right - range.left + 1) % width === 0;
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

// ---- Values ------------------------------------------------------------------------------------

/** Whether a type holds figures: they stand at the cell's end, in ink. */
export const isFigure = (type: DataGridColumnType) =>
  type === "number" || type === "currency";

// A number format is slow to make and a grid asks for one per figure it draws: one per locale and
// way of writing, made once.
const formats = new Map<string, Intl.NumberFormat>();
const formatFor = (locale: string, options: Intl.NumberFormatOptions) => {
  const key = `${locale} ${JSON.stringify(options)}`;
  const known = formats.get(key);
  if (known !== undefined) {
    return known;
  }
  const made = new Intl.NumberFormat(locale, options);
  formats.set(key, made);
  return made;
};

/**
 * A value as it is typed and copied: a figure plain, with no grouping, the locale's decimal mark
 * and Latin digits, so a spreadsheet in that locale reads it back, and so does the grid.
 */
export const plainOf = (value: DataGridCellValue, locale: string): string => {
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  if (typeof value === "number") {
    return formatFor(locale, {
      useGrouping: false,
      maximumFractionDigits: 20,
      numberingSystem: "latn",
    }).format(value);
  }
  return value ?? "";
};

// Words that start like a formula (=, +, -, @, a tab or a return) run as one when a spreadsheet
// takes them: a leading apostrophe keeps them text, as the Data table's CSV export does. Figures
// are numbers and are left alone. Pasted back, the apostrophe goes again.
const formula = /^[=+\-@\t\r]/u;
const guard = /^'(?=[=+\-@\t\r])/u;

/** A value as it goes on the clipboard: plain, and words that start like a formula kept as text. */
export const copiedOf = (value: DataGridCellValue, locale: string): string =>
  typeof value === "string" && formula.test(value)
    ? `'${value}`
    : plainOf(value, locale);

/** A value as its cell shows it. */
export const shownOf = <Row>(
  column: DataGridColumn<Row>,
  value: DataGridCellValue,
  locale: string
): string => {
  if (column.format !== undefined) {
    return column.format(value);
  }
  if (typeof value !== "number") {
    return plainOf(value, locale);
  }
  const digits = column.type === "currency" ? 2 : undefined;
  return formatFor(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
};

const truthy = /^(?:true|yes|x|1|✓)$/iu;

const escaped = (mark: string) =>
  mark.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);

// How a figure is written in a locale, made once per locale: digits in threes split by the
// locale's mark or a space, or not split, then the decimal mark and the rest.
const figures = new Map<
  string,
  { pattern: RegExp; group: string; decimal: string }
>();
const figuresFor = (locale: string) => {
  const known = figures.get(locale);
  if (known !== undefined) {
    return known;
  }
  const parts = formatFor(locale, { numberingSystem: "latn" }).formatToParts(
    12_345.6
  );
  const decimal = parts.find((part) => part.type === "decimal")?.value ?? ".";
  const group = parts.find((part) => part.type === "group")?.value ?? ",";
  const made = {
    pattern: new RegExp(
      String.raw`^[+-]?(?:\d{1,3}(?:(?:${escaped(group)}|\s)\d{3})+|\d+)(?:${escaped(decimal)}\d+)?$`,
      "u"
    ),
    group,
    decimal,
  };
  figures.set(locale, made);
  return made;
};

/**
 * A figure as people type it in their locale, or `undefined` when the words are not one: a sign,
 * digits in threes split by the locale's mark or a space, its decimal mark, and a currency's sign
 * anywhere. "1.234,50" is 1234.5 in German and "1,234.50" in English; "1,234.50" in German and
 * "1/2" are not figures.
 */
const figureOf = (text: string, locale: string) => {
  const { pattern, group, decimal } = figuresFor(locale);
  const bare = text
    .replaceAll(/\p{Sc}/gu, "")
    .trim()
    .replace("−", "-");
  return pattern.test(bare)
    ? Number(
        bare.replaceAll(group, "").replaceAll(/\s/gu, "").replace(decimal, ".")
      )
    : undefined;
};

// An option by its words, any case, or by the start of the one option they begin.
const optionFor = (options: readonly string[], text: string) => {
  const wanted = text.toLowerCase();
  const exact = options.find((option) => option.toLowerCase() === wanted);
  if (exact !== undefined) {
    return exact;
  }
  const starting = options.filter((option) =>
    option.toLowerCase().startsWith(wanted)
  );
  return starting.length === 1 ? starting[0] : undefined;
};

/** What typed or pasted words become in a column, or `undefined` when they do not fit it. */
export const valueFrom = <Row>(
  column: DataGridColumn<Row>,
  words: string,
  locale: string
): DataGridCellValue | undefined => {
  const text = words.trim();
  if (column.type === "boolean") {
    return truthy.test(text);
  }
  if (isFigure(column.type)) {
    return text === "" ? null : figureOf(text, locale);
  }
  if (column.type === "select" && column.options !== undefined && text !== "") {
    return optionFor(column.options, text);
  }
  return text.replace(guard, "");
};

/** What a cell holds once cleared: a box empties, a figure goes, words go. */
export const clearedOf = (type: DataGridColumnType): DataGridCellValue => {
  if (type === "boolean") {
    return false;
  }
  return isFigure(type) ? null : "";
};

// ---- Sort --------------------------------------------------------------------------------------

/** The column the rows are sorted by, and which way. */
export interface Sort {
  key: string;
  direction: "ascending" | "descending";
}

const asText = (value: DataGridCellValue) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const compare = (a: DataGridCellValue, b: DataGridCellValue) => {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Number(a) - Number(b);
  }
  return asText(a).localeCompare(asText(b), undefined, { numeric: true });
};

/** The rows in the sort's order; equal rows keep theirs. */
export const sortRows = <Row>(
  rows: readonly Row[],
  columns: readonly DataGridColumn<Row>[],
  sort: Sort | null
): readonly Row[] => {
  const column = columns.find((each) => each.key === sort?.key);
  if (column === undefined || sort === null) {
    return rows;
  }
  const way = sort.direction === "descending" ? -1 : 1;
  return rows.toSorted(
    (a, b) => way * compare(column.value(a), column.value(b))
  );
};

/** The next sort after a press on a column's name: up, then down, then as given. */
export const nextSort = (sort: Sort | null, key: string): Sort | null => {
  if (sort?.key !== key) {
    return { key, direction: "ascending" };
  }
  return sort.direction === "ascending"
    ? { key, direction: "descending" }
    : null;
};

// ---- Undo --------------------------------------------------------------------------------------

/** The edits made: those undo can take back (oldest first), and those redo can put back. */
export interface History {
  done: DataGridPatch[];
  undone: DataGridPatch[];
}

/** The history after a new patch, kept to its last 200: it can be undone, nothing redone. */
export const record = (state: History, patch: DataGridPatch): History => ({
  done: [...state.done, patch].slice(-200),
  undone: [],
});

const invert = ({ kind, changes }: DataGridPatch): DataGridPatch => ({
  kind,
  changes: changes.toReversed().map(({ rowId, columnId, from, to }) => ({
    rowId,
    columnId,
    from: to,
    to: from,
  })),
});

/** The patch that undoes (`back`) or redoes the latest step, and the history after it. */
export const stepHistory = (
  state: History,
  back: boolean
): { patch: DataGridPatch; state: History } | null => {
  const last = (back ? state.done : state.undone).at(-1);
  if (last === undefined) {
    return null;
  }
  return back
    ? {
        patch: invert(last),
        state: {
          done: state.done.slice(0, -1),
          undone: [...state.undone, last],
        },
      }
    : {
        patch: last,
        state: {
          done: [...state.done, last],
          undone: state.undone.slice(0, -1),
        },
      };
};
