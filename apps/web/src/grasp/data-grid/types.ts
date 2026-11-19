// The Data grid's public types: its columns by kind, its looks, and its props.
import type { IconData } from "../icons";
import type { CellValue, Patch, Selection } from "./model";
import type { DataGridWords } from "./words";

/** How the active cell is drawn: a soft halo (the default), lifted off the sheet, or an underline. */
export type DataGridActiveLook = "halo" | "lifted" | "underline";
/** How a chosen range is drawn: a wash with a pine edge (the default), a firmer mint edge, or dither. */
export type DataGridRangeLook = "wash" | "outline" | "dither";
/** How the head is drawn: quiet on a soft ground (the default), lifted, or with kind chips. */
export type DataGridHeaderLook = "quiet" | "lifted" | "chip";

/** The grid's looks, each with a provisional default. */
export interface DataGridLook {
  /** The active cell. @default "halo" */
  active?: DataGridActiveLook;
  /** A chosen range. @default "wash" */
  range?: DataGridRangeLook;
  /** The head row. @default "quiet" */
  header?: DataGridHeaderLook;
}

/** What a column holds: it sets the cell's look, its editor and how typed or pasted words are read. */
export type DataGridKind =
  | "text"
  | "number"
  | "currency"
  | "select"
  | "date"
  | "person"
  | "checkbox";

/** One column: what it is called, what it holds, and how it shows. */
export interface DataGridColumn<Row> {
  /** A short, unique name for the column in code ("budget"). */
  key: string;
  /** The column's name in its head, short and in sentence case. */
  header: string;
  /** Its kind. */
  kind: DataGridKind;
  /** The row's value in this column: what it shows, sorts by, copies and edits. */
  value: (row: Row) => CellValue;
  /** How the value shows, when the kind's own way is not enough. */
  format?: (value: CellValue) => string;
  /** A select's values: typed or pasted words must be one of them. */
  options?: readonly string[];
  /** Its cells cannot be edited. @default false */
  readOnly?: boolean;
  /** Its name can be pressed to sort the rows by it. @default false */
  sortable?: boolean;
  /** Its share of spare room beside the other columns. @default 1 */
  grow?: number;
  /** An icon for its head, in place of its kind's. */
  icon?: IconData;
}

/** Every prop a DataGrid takes. `Row` is the shape of one row of your data. */
export interface DataGridProps<Row> {
  /** What the rows are, in a word or two ("Launch plan"): the grid's name. */
  label: string;
  /** The columns, in order. */
  columns: readonly DataGridColumn<Row>[];
  /** The rows of data. The grid stores none: apply each patch to them yourself. */
  rows: readonly Row[];
  /** A unique, lasting key for a row: its id. */
  rowKey: (row: Row) => string;
  /**
   * Called with every edit, paste, clear, undo and redo, as the cells it changes. Apply it to your
   * rows; without it the grid is read-only.
   */
  onPatch?: (patch: Patch) => void;
  /** How the active cell, a range and the head are drawn. */
  appearance?: DataGridLook;
  /** @deprecated Use `appearance`. */
  look?: DataGridLook;
  /** What is chosen at first: one cell, or a range. The first cell, unless given. */
  defaultSelection?: Selection;
  /**
   * What Tab does on a cell. "move" steps to the next cell as a spreadsheet does, Shift+Tab to the
   * one before, and it leaves after the last cell and before the first. "leave" makes the grid one
   * stop: Tab leaves at once and the arrows alone move inside. An open editor's Tab commits and
   * moves on either way. @default "move"
   */
  tab?: "move" | "leave";
  /** A column of row numbers at the start. @default true */
  numbered?: boolean;
  /** Columns can be made wider or narrower by the handle at a head's end. @default false */
  resizable?: boolean;
  /** The locale figures are written in. @default the catalogue's locale (GraspWords), else "en" */
  locale?: string;
  /** The words it shows and says, to replace the English ones: any of them. */
  words?: Partial<DataGridWords>;
}
