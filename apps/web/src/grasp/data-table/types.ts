// The Data table's public types: its columns, its sort, what can be done to its rows, and its props.
import type { ReactNode } from "react";

import type { EmptyPicture, EmptyShape } from "../empty";
import type { IconData } from "../icons";
import type { TableDensity, TableHeadLook, TableRangeLook } from "../table";
import type { createToaster } from "../toast";
import type { DataTablePiece } from "./engine";
import type { DataTableFilterWords } from "./filters";
import type { DataTableLocation } from "./location";
import type { DataTableWords } from "./words";

/** One column: what it is called, what it holds, and how it shows. */
export interface DataTableColumn<Row> {
  /** A short, unique name for the column in code ("pages"). */
  key: string;
  /** The column's name in its head, short and in sentence case ("Last edited"). */
  header: string;
  /** The row's value in this column: what it sorts by and what a search looks in. */
  value: (row: Row) => string | number;
  /** How the value shows, when the plain value is not enough: a badge, a link. */
  cell?: (row: Row) => ReactNode;
  /** `end` for figures, so they line up. @default "start" */
  align?: "start" | "end";
  /**
   * Its cell holds a small control (a Select, a Switch, a button): the control stands in a box one
   * line of the table's text tall, as the row's menu does, so the row keeps its height at every
   * density.
   * @default false
   */
  control?: boolean;
  /**
   * Its words may wrap onto more lines: a column that holds sentences. Only the first column wraps
   * by itself; the rest stay on one line, and on a phone the table scrolls sideways instead.
   * @default false
   */
  wrap?: boolean;
  /** Its name can be pressed to sort the rows by it, and again to turn the order over. @default false */
  sortable?: boolean;
  /** It starts hidden, with the `view` piece; the View menu shows it. @default false */
  hidden?: boolean;
  /** It starts held at the start or the end, with the `pinning` piece. */
  pin?: "start" | "end";
  /**
   * How the Filter builder filters by it, with `filterable`: words it holds, a figure it is at
   * least or at most, or one of a few values; `false` leaves it out.
   * @default "text"
   */
  filter?: "text" | "number" | { options: readonly string[] } | false;
}

/** The order the rows stand in. */
export interface DataTableSort {
  /** The column's `key`. */
  key: string;
  /** Low to high, or high to low. */
  order: "ascending" | "descending";
}

/** A grave action's question, and what it says will happen. */
export interface DataTableQuestion {
  title: string;
  description: string;
}

/** Something to do with the chosen rows, from the bar that shows while rows are chosen. */
export interface DataTableAction {
  /** What it does, on its button ("Archive"). */
  label: string;
  /** An icon before the words, from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /**
   * What a mistake would cost, which picks how it is confirmed (the confirm rule): `undoable` is
   * done at once with Undo in a Toast; `moderate` is held to confirm; `grave` asks in an Alert
   * dialog.
   */
  stake: "undoable" | "moderate" | "grave";
  /** Does it to the chosen rows' keys. An undoable one returns what undoes it. */
  run: (keys: string[]) => (() => void) | undefined;
  /**
   * A grave one's question and what it says will happen, in the Alert dialog: fixed words, or
   * words from how many rows are chosen, so one row reads "Delete this report?".
   */
  confirm?: DataTableQuestion | ((count: number) => DataTableQuestion);
}

/** One thing to do with a single row, in its actions menu. */
export interface DataTableRowAction {
  /** What it does ("Rename"). */
  label: string;
  /** Does it. */
  onSelect: () => void;
}

/** What a row is called, one and many, for the count, the search and the pages. */
export interface DataTableUnit {
  one: string;
  other: string;
}

/**
 * What the table says in its rows' place: an Empty's own words, picture and way on, as the Empty
 * and error states pattern asks.
 */
export interface DataTableEmpty {
  /** A short title: "No reports yet". */
  title?: string;
  /** One sentence: what will appear here and when, or what to change. */
  description: string;
  /** An icon above the title, from src/icons. A `picture` takes its place. */
  icon?: IconData;
  /** Empty's small drawing of the case: `nothing`, `search`, `done`, `locked`, `offline`, `broken`. */
  picture?: EmptyPicture;
  /** Empty's faint picture of what will stand here: `rows` for a table. */
  shape?: EmptyShape;
  /** The way on, under the sentence: one Button ("New report", "Clear the search"). */
  action?: ReactNode;
}

/** What a table that found nothing was asked, handed to `noMatch` so its words can name it. */
export interface DataTableAsked {
  /** The words in the search, or "" when it is empty. */
  query: string;
  /** The filter that is set, or null: its column's key and header, the operator's id, the value. */
  filter: {
    column: string;
    header: string;
    operator: string;
    value: string;
  } | null;
  /** Empties the search and takes the filter off: every row comes back. */
  clear: () => void;
}

/** Every prop a DataTable takes. `Row` is the shape of one row of your data. */
export interface DataTableProps<Row> {
  /** What the rows are, in a word or two ("Reports"): the table's name, and the search's. */
  label: string;
  /**
   * The table's caption: a short sentence under it. A table always has a name a screen reader
   * meets: this caption when you give one, the `label` when you do not.
   */
  caption?: ReactNode;
  /** The columns, in order. The first names the row. */
  columns: readonly DataTableColumn<Row>[];
  /** The rows of data, in the order they start in. */
  rows: readonly Row[];
  /** A unique, lasting key for a row: its id. */
  rowKey: (row: Row) => string;
  /**
   * The order it starts in, when a column is sortable: one column, or several, the first deciding
   * most.
   */
  defaultSort?: DataTableSort | readonly DataTableSort[];
  /** The order, when you keep it in state (sorting on a server). Pair it with `onSortChange`. */
  sort?: readonly DataTableSort[];
  /** Called with the new order each time a column's name is pressed. */
  onSortChange?: (sort: DataTableSort[]) => void;
  /** What the search holds, when you keep it in state (searching on a server). */
  query?: string;
  /** Called with what the search holds each time it changes. */
  onQueryChange?: (query: string) => void;
  /** The page shown, from 1, when you keep it in state (paging on a server). */
  page?: number;
  /** Called with the page to show. */
  onPageChange?: (page: number) => void;
  /**
   * The rows are sorted, searched and paged by a server: `rows` is the page to show, already in
   * order, and `rowCount` is how many there are in all. Keep `sort`, `query` and `page` in state
   * and fetch on their changes.
   */
  server?: { rowCount: number };
  /** Features beyond sorting, searching, choosing and pages, each imported on its own (pieces.ts). */
  pieces?: readonly DataTablePiece[];
  /** A search field above it that keeps the rows whose values hold what is typed. @default false */
  searchable?: boolean;
  /**
   * A checkbox at the start of every row, and one in the head that chooses every row shown.
   * @default false
   */
  selectable?: boolean;
  /** The keys of the chosen rows, when you keep them in state. Pair it with `onSelectedChange`. */
  selected?: readonly string[];
  /** The keys chosen at first, when you do not keep them in state. */
  defaultSelected?: readonly string[];
  /** Called with the keys of the chosen rows each time the choice changes. */
  onSelectedChange?: (keys: string[]) => void;
  /**
   * How many rows a page holds. The pages appear under the table only once more rows are found
   * than one page holds; a search or a filter goes back to page 1. Leave it out and every row
   * shows on one page. While `loading`, as many placeholder rows stand as a page holds, or 5.
   * @default none: every row on one page
   */
  pageSize?: number;
  /**
   * What a row is called, one and many, for the count, the search and the pages.
   * @default { one: "row", other: "rows" }
   */
  unit?: DataTableUnit;
  /**
   * How much room a row has: `compact` 32px, `default` 42px, `roomy` 50px.
   * @default "default"
   */
  density?: TableDensity;
  /**
   * The tallest the table grows (a CSS length, "28rem"); its rows then scroll under a head that
   * stays in view.
   */
  height?: string;
  /**
   * The first column (and the checkboxes) stays in view while the rest scroll sideways.
   * @default false
   */
  stickyFirst?: boolean;
  /**
   * The Filter builder above the table, on the columns' `filter`: one condition at a time.
   * @default false
   */
  filterable?: boolean;
  /** What can be done to the chosen rows, in a bar that shows while rows are chosen. */
  actions?: readonly DataTableAction[];
  /** What can be done to one row, in a menu at its end. */
  rowActions?: (row: Row) => readonly DataTableRowAction[];
  /** With the `expanding` piece: a detail that opens under a row. */
  detail?: (row: Row) => ReactNode;
  /** With the `expanding` piece: rows of its own that open under a row. */
  subRows?: (row: Row) => readonly Row[] | undefined;
  /** With the `grouping` piece: the column whose values gather the rows, each group counted. */
  groupBy?: string;
  /**
   * Where the Undo toasts go, when the page has its own Toaster. Leave it out and the table shows
   * its own.
   */
  toaster?: ReturnType<typeof createToaster>;
  /** The rows are on their way: placeholders stand in their place, then the rows fade in. */
  loading?: boolean;
  /** The rows did not load: the table says so, with Try again when there is `onRetry`. */
  failed?: { title?: string; description?: string; onRetry?: () => void };
  /**
   * What the table says when there are no rows yet (not when a search or a filter finds none):
   * its words, and an Empty's picture and action when it has them.
   * @default the words' `noneYet`: "No reports yet."
   */
  empty?: DataTableEmpty;
  /**
   * What the table says when the search or the filter finds no row. It is handed what was asked
   * (the words searched, the filter set, and `clear`), so the words can name it and the action
   * can undo it.
   * @default one line from the words: `noMatch` for a search, `noneMeet` for a filter
   */
  noMatch?: (asked: DataTableAsked) => DataTableEmpty;
  /** Endless loading: runs as the last row comes into view, while `hasMore`. Leave `pageSize` out. */
  onEndReached?: () => void;
  /** There are rows still to come for `onEndReached`. @default false */
  hasMore?: boolean;
  /** Rows are being fetched for `onEndReached`: placeholders follow the last row. @default false */
  loadingMore?: boolean;
  /** Export CSV in the bar: the rows found and the columns shown, as a file of this name. */
  exportable?: string;
  /** Where the view lives (`queryLocation()` keeps it in the query string), so a link reopens it. */
  location?: DataTableLocation;
  /** The words it shows and says, to replace the English ones: any of them. */
  words?: Partial<DataTableWords>;
  /** The Filter builder's operators' words, to replace the English ones. */
  filterWords?: Partial<DataTableFilterWords>;
  /**
   * How chosen rows and the head show, where the system's look (Table's `tableLook`: the Data grid's
   * mint wash and soft head) is not wanted.
   */
  appearance?: { range?: TableRangeLook; head?: TableHeadLook };
  /** @deprecated Use `appearance`. */
  look?: { range?: TableRangeLook; head?: TableHeadLook };
}
