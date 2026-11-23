// DataTable: a Table that sorts, searches, selects rows and pages through them, on TanStack Table,
// given a data API: columns and rows as data, so the same table is known to
// a server, an agent and a person. Sorting takes several columns (Shift and a column's name adds
// it); selecting takes a range (Shift and a checkbox). The rest comes as features (features.ts),
// each opt-in. Its words come from the I18nProvider (`dataTable`).
//
//   <DataTable
//     aria-label="Reports"
//     rows={reports}
//     getRowId={(report) => report.id}
//     columns={[
//       { id: "name", header: "Report", value: (report) => report.name, sortable: true },
//       { id: "pages", header: "Pages", value: (report) => report.pages, align: "end", sortable: true },
//     ]}
//     searchable
//     selectable
//     pageSize={10}
//   />
"use client";

import * as stylex from "@stylexjs/stylex";
import { functionalUpdate, useTable } from "@tanstack/react-table";
import type {
  Column,
  ColumnDef,
  ColumnOrderState,
  ColumnPinningState,
  ColumnSizingState,
  ExpandedState,
  Row as TableRowModel,
  RowData,
  RowSelectionState,
  SortingState,
  TableState,
  Updater,
} from "@tanstack/react-table";
import { definePrimitive } from "@ui-sdk/core";
import { usePart, usePrimitive } from "@ui-sdk/react/primitive";
import {
  isValidElement,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  ChangeEvent,
  DragEvent,
  MouseEvent,
  ReactNode,
  TouchEvent,
} from "react";

import { useI18n, useLocale } from "../../lib/i18n";
import type { I18nCatalog } from "../../lib/i18n";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  DownloadIcon,
  EllipsisIcon,
  Icon,
  InfoIcon,
  SearchIcon,
  SlidersHorizontalIcon,
} from "../../lib/icons";
import type { IconData } from "../../lib/icons";
import {
  focusRingInset,
  focusRingText,
  visuallyHidden,
} from "../../lib/styles";
import {
  colors,
  font,
  media,
  radius,
  size,
  space,
} from "../../lib/tokens.stylex";
import { ownValue } from "../../lib/utils";
import type { LayoutStyle } from "../../lib/utils";
import { ringInsetMarker } from "../../lib/vars.stylex";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../alert-dialog";
import { Badge } from "../badge";
import { Button } from "../button";
import { Checkbox } from "../checkbox";
import type { CheckedState } from "../checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../empty";
import type { EmptyIllustration } from "../empty";
import { Field, FieldLabel } from "../field";
import { HoldButton } from "../hold-button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupClear,
  InputGroupInput,
} from "../input-group";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
  PaginationRange,
} from "../pagination";
import { Skeleton } from "../skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../table";
import type { TableDensity, TablePin } from "../table";
import { toast as pageToast } from "../toast";
import type { createToaster } from "../toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import { featuresFor, has, saveCsv, toCsv } from "./features";
import type {
  DataTableFeature,
  DataTableLocation,
  DataTableView,
  Features,
} from "./features";
import {
  asText,
  DataTableFilters,
  fieldFor,
  isSet,
  noCondition,
  passes,
} from "./filters";
import type {
  ColumnFilter,
  DataTableFilterCondition,
  DataTableFilterField,
} from "./filters";

// ---- The public types ----------------------------------------------------------------------------

/** One column: what it is called, what it holds, and how it shows. */
export interface DataTableColumn<Row> {
  /** A short, unique name for the column in code ("pages"). */
  id: string;
  /** The column's name in its head, short and in sentence case ("Last edited"). */
  header: string;
  /** The row's value in this column: what it sorts by, and what a search looks in. */
  value: (row: Row) => string | number;
  /**
   * The value as words, where `value` is not words to read (a date's time in milliseconds): what
   * its cell's title says, what a search looks in and what the export writes.
   * @default the value
   */
  text?: (row: Row) => string;
  /** How the value shows, when the plain value is not enough: a badge, a link. */
  cell?: (row: Row) => ReactNode;
  /** `end` for figures, so they line up. @default "start" */
  align?: "start" | "end";
  /**
   * Its cell holds a small control (a Select, a Switch, a button): the control stands in a box one
   * line of the table's text tall, so the row keeps its height at every density. In a row that
   * opens, the control stays its own, over the row's press area.
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
  /**
   * Its shape while the table is `loading`: `person` waits as a person's cell does, a picture's
   * circle and two lines (a name and its email), so the row stands as tall as it will.
   * @default "line"
   */
  skeleton?: "line" | "person";
  /** It starts hidden, with `columnVisibilityFeature`; the View menu shows it. @default false */
  hidden?: boolean;
  /** It starts held at the start or the end, with `columnPinningFeature`. */
  pinned?: "start" | "end";
  /**
   * It goes when the table's own box is narrower than the `sm` (40rem) or `md` (48rem) breakpoint,
   * its head and its cells. Never the column a fact lives in alone, and never the first column.
   */
  hideBelow?: "sm" | "md";
  /** More about the column, in a tooltip behind an info mark beside its name: a sentence or two. */
  description?: string;
  /**
   * How `filterable` filters by it: words it holds, a figure it is at least or at most, or one of
   * a few values; `false` leaves it out.
   * @default "text"
   */
  filter?: ColumnFilter | false;
}

/** The order the rows stand in. */
export interface DataTableSort {
  /** The column's `id`. */
  key: string;
  /** Low to high, or high to low. */
  order: "ascending" | "descending";
}

/** A grave action's question, and what it says will happen. */
export interface DataTableConfirm {
  title: string;
  description: string;
}

/** Something to do with the selected rows, from the bar that shows while rows are selected. */
export interface DataTableAction {
  /** What it does, on its button ("Archive"). */
  label: string;
  /** An icon before the words, from lib/icons. */
  icon?: IconData;
  /**
   * What a mistake would cost, which picks how it is confirmed: `undoable` is done at once with
   * Undo in a Toast; `moderate` is held to confirm; `grave` asks in an Alert dialog.
   */
  severity: "undoable" | "moderate" | "grave";
  /** Does it to the selected rows' ids. An undoable one returns what undoes it. */
  run: (ids: string[]) => (() => void) | undefined;
  /** A grave one's question: fixed words, or words from how many rows are selected. */
  confirm?: DataTableConfirm | ((count: number) => DataTableConfirm);
}

/** One thing to do with a single row, in its actions menu. */
export interface DataTableRowAction {
  /** What it does ("Rename"). */
  label: string;
  /** Does it. */
  onSelect: () => void;
}

/** What a row is called, one and many, for the count, the search and the states. */
export interface DataTableUnit {
  one: string;
  other: string;
}

/** What the table says in its rows' place: an Empty's own words, picture and way on. */
export interface DataTableEmptyState {
  /** A short title: "No reports yet". */
  title?: string;
  /** One sentence: what will appear here and when, or what to change. */
  description: string;
  /** An icon above the title, from lib/icons. A `picture` takes its place. */
  icon?: IconData;
  /** Empty's small drawing of the case: `nothing`, `search`, `done`, `locked`, `offline`, `broken`. */
  picture?: EmptyIllustration;
  /** The way on, under the sentence: one Button ("New report", "Clear the search"). */
  action?: ReactNode;
}

/** What a table that found nothing was asked, handed to `noResults` so its words can name it. */
export interface DataTableSearchState {
  /** The words in the search, or "" when it is empty. */
  query: string;
  /** The filter that is set, or null: its column's id and header, the operator's id, the value. */
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
  /** What the rows are, in a word or two ("Reports"): the table's name, and its search's. */
  "aria-label": string;
  /**
   * The table's caption: a short sentence under it. A table always has a name a screen reader
   * meets: this caption when you give one, the `aria-label` when you do not.
   */
  caption?: ReactNode;
  /** The columns, in order. The first names the row. */
  columns: readonly DataTableColumn<Row>[];
  /** The rows of data, in the order they start in. */
  rows: readonly Row[];
  /** A unique, lasting id for a row. */
  getRowId: (row: Row) => string;
  /** The order it starts in: one column, or several, the first deciding most. */
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
   * How many rows a page holds. The pages appear under the table only once more rows are found
   * than one page holds; a search or a filter goes back to page 1. While `loading`, as many
   * placeholder rows stand as a page holds, or 5.
   * @default none: every row on one page
   */
  pageSize?: number;
  /**
   * The rows are sorted, searched and paged by a server: `rows` is the page to show, in order, and
   * this is how many there are in all. Keep `sort`, `query` and `page` in state and fetch on them.
   */
  rowCount?: number;
  /** Features beyond sorting, searching, selecting and pages, each imported on its own. */
  features?: readonly DataTableFeature[];
  /** A search field above it that keeps the rows whose values hold what is typed. @default false */
  searchable?: boolean;
  /** A checkbox at the start of every row, and one in the head for every row shown. @default false */
  selectable?: boolean;
  /** The ids of the selected rows, when you keep them in state. Pair it with `onSelectionChange`. */
  selection?: readonly string[];
  /** The ids selected at first, when you do not keep them in state. */
  defaultSelection?: readonly string[];
  /** Called with the ids of the selected rows each time the selection changes. */
  onSelectionChange?: (ids: string[]) => void;
  /** What a row is called, one and many, for the count, the search and the states. */
  unit?: DataTableUnit;
  /**
   * How much room a row has: `compact` 32px, `default` 42px, `comfortable` 50px.
   * @default "default"
   */
  density?: TableDensity;
  /** The tallest the table grows (a CSS length, "28rem"); its rows then scroll under its head. */
  height?: string;
  /** The first column (and the checkboxes) stays in view while the rest scroll sideways. @default false */
  stickyFirstColumn?: boolean;
  /** A filter above the table, on the columns' `filter`: one condition at a time. @default false */
  filterable?: boolean;
  /** What can be done to the selected rows, in a bar that shows while rows are selected. */
  actions?: readonly DataTableAction[];
  /** What can be done to one row, in a menu at its end. */
  rowActions?: (row: Row) => readonly DataTableRowAction[];
  /**
   * Each row opens a page: its address. The lead column's words become a real link, the whole row
   * its press area; the row's other controls stay their own. With `stickyFirstColumn` the held
   * lead cell is its press area. One of `getRowHref` and `onRowClick`.
   */
  getRowHref?: (row: Row) => string;
  /** Each row opens something on this page (a panel): the lead column's words become a button. */
  onRowClick?: (row: Row) => void;
  /** The row open now (its panel shows beside the table): said as current, with a quiet fill. */
  isRowActive?: (row: Row) => boolean;
  /** With `rowExpandingFeature`: a detail that opens under a row. */
  renderDetailPanel?: (row: Row) => ReactNode;
  /** With `rowExpandingFeature`: rows of its own that open under a row. */
  getSubRows?: (row: Row) => readonly Row[] | undefined;
  /** With `groupingFeature`: the column whose values gather the rows, each group counted. */
  groupBy?: string;
  /** With `groupingFeature`: the groups collapsed, by value, when you keep them in state. */
  collapsedGroups?: readonly string[];
  /** With `groupingFeature`: the groups collapsed at first, by value. */
  defaultCollapsedGroups?: readonly string[];
  /** With `groupingFeature`: called with the groups collapsed each time one opens or closes. */
  onCollapsedGroupsChange?: (collapsed: string[]) => void;
  /**
   * A row's state, drawn over the whole row and said in its first cell: `pending` fades from the
   * row's start to its end; `removed` greys it. Its actions stay whole and usable.
   */
  getRowStatus?: (row: Row) => "pending" | "removed" | undefined;
  /** With `groupingFeature`: a group that asks for attention, by its value: its count takes the tone. */
  getGroupVariant?: (value: string) => "warning" | undefined;
  /**
   * Where its toasts go. Leave it out and they go to the page's shared `toast`, which the page's
   * one `<Toaster />` draws. Give one only for a host that keeps a queue of its own.
   */
  toaster?: ReturnType<typeof createToaster>;
  /** The rows are on their way: placeholders stand in their place, then the rows fade in. */
  loading?: boolean;
  /** The rows did not load: the table says so, with Try again when there is `onRetry`. */
  error?: { title?: string; description?: string; onRetry?: () => void };
  /**
   * What the table says when there are no rows yet (not when a search or a filter finds none).
   * @default the I18nProvider's `dataTable.noneYet`: "No reports yet."
   */
  emptyState?: DataTableEmptyState;
  /**
   * What the table says when the search or the filter finds no row, handed what was asked so the
   * words can name it and the action can undo it.
   * @default one line: `dataTable.noMatch` for a search, `dataTable.noneMeet` for a filter
   */
  noResults?: (state: DataTableSearchState) => DataTableEmptyState;
  /** Endless loading: runs as the last row comes into view, while `hasMore`. Leave `pageSize` out. */
  onEndReached?: () => void;
  /** There are rows still to come for `onEndReached`. @default false */
  hasMore?: boolean;
  /** Rows are being fetched for `onEndReached`: placeholders follow the last row. @default false */
  loadingMore?: boolean;
  /** Export CSV in the bar: the rows found and the columns shown, as a file of this name. */
  exportFileName?: string;
  /** Where the view lives (`searchParamsLocation()` keeps it in the query string). */
  location?: DataTableLocation;
  /** Layout only: its width and where it sits. */
  style?: LayoutStyle;
}

// ---- Styles --------------------------------------------------------------------------------------

const HOVER = media.hover;
const COARSE = media.pointerCoarse;
const endLine = (color: string, side: "left" | "right") =>
  `linear-gradient(to ${side}, ${color} ${size.lineStrong}, transparent ${size.lineStrong})`;

const styles = stylex.create({
  root: { display: "grid", gap: space[3], width: "100%", minWidth: 0 },
  // The table's own box, which keeps its last height while rows are on their way.
  hold: { minWidth: 0 },
  keeps: (height: string) => ({ minHeight: height }),
  // A control's height whether or not rows are selected, so the table under it never moves.
  bar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space[3],
    minHeight: size.controlDefault,
  },
  // On a phone the search has the row to itself, to the table's edge.
  search: { flexGrow: 1, maxWidth: { default: 320, [media.maxSm]: "none" } },
  count: {
    marginInlineStart: "auto",
    color: colors.mutedForeground,
    fontSize: font.textSm,
    fontVariantNumeric: "tabular-nums",
  },
  // While the rows load there is nothing to count: the line keeps its room, unseen and unsaid.
  countWaiting: { visibility: "hidden" },
  // The bar while rows are selected: a fieldset, its own frame taken away.
  bulk: {
    margin: 0,
    padding: 0,
    borderWidth: 0,
    minInlineSize: 0,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space[2],
    marginInlineStart: "auto",
  },
  atEnd: { display: "inline-flex", marginInlineStart: "auto" },
  muted: { color: colors.mutedForeground, textAlign: "center" },
  // A row's checkbox takes only its box's room in the cell; its 44px reach spills over (reach),
  // ending inside its own cell's padding, never over the next column's controls.
  pick: {
    display: "block",
    width: `calc(${size.tapTarget} - ${space.tableCellInline})`,
    height: size.tableTextLine,
  },
  reach: { display: "flow-root", width: size.tapTarget },
  // The Checkbox's row is 44px tall; lifted by half the difference it stands on the cell's line.
  lift: {
    display: "block",
    marginBlock: `calc((${size.tableTextLine} - ${size.tapTarget}) / 2)`,
  },
  // Its words are hidden but keep a width, so the Checkbox's own reach is 44px wide too.
  pickWords: {
    display: "inline-block",
    width: `calc(${size.tapTarget} - ${size.checkboxBox} - ${space[3]})`,
    height: 1,
    overflow: "hidden",
    whiteSpace: "nowrap",
    color: "transparent",
  },
  // A group's heading row: a step above a row (15 on 24 at semibold), with more room above it.
  group: {
    display: "inline-flex",
    alignItems: "center",
    gap: space[2],
    height: font.textBaseLine,
    marginBlockStart: space[3],
    verticalAlign: "top",
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    fontWeight: font.weightSemibold,
    color: colors.foreground,
  },
  figures: { fontVariantNumeric: "tabular-nums" },
  // The first cell of a row that opens: its toggle, then its words, held to the line's height.
  opener: {
    display: "inline-flex",
    alignItems: "center",
    gap: space[1],
    height: size.tableTextLine,
    verticalAlign: "top",
  },
  nowrap: { whiteSpace: "nowrap" },
  depth: (depth: number) => ({
    paddingInlineStart: `calc(${depth} * ${space[6]})`,
  }),
  // Where a toggle would be, for a row that does not open, so the words line up.
  toggleRoom: {
    display: "inline-block",
    width: size.controlXs,
    flexShrink: 0,
  },
  // A control in a cell (a toggle, a menu, a Select): in a box as tall as the line, above the row's
  // press area and its state's veil, so the row keeps its height and the control stays its own.
  inLine: {
    display: "inline-flex",
    position: "relative",
    zIndex: 1,
    alignItems: "center",
    verticalAlign: "top",
    height: size.tableTextLine,
  },
  // An xs control takes no more height than the words.
  inRow: {
    display: "inline-flex",
    position: "relative",
    zIndex: 1,
    marginBlock: `calc((${size.tableTextLine} - ${size.controlXs}) / 2)`,
  },
  above: { position: "relative", zIndex: 1 },
  // A row that opens: its name, a link or a button drawn as the cell's plain words, its press area
  // stretched over the row (TableRow's `interactive`). Its ring is the row's.
  rowTarget: {
    display: "inline",
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: "inherit",
    font: "inherit",
    letterSpacing: "inherit",
    textAlign: "start",
    textDecoration: "none",
    overflowWrap: "inherit",
    cursor: "pointer",
    outline: "none",
    "::after": { content: '""', position: "absolute", inset: 0, zIndex: 0 },
  },
  // A row that speaks for the whole table: as wide as the box shows, held while the table scrolls.
  across: {
    position: "sticky",
    insetInlineStart: space.tableCellInline,
    width: `calc(100cqi - 2 * ${space.tableCellInline})`,
    maxWidth: "100%",
  },
  detail: {
    paddingBlock: space[2],
    paddingInlineStart: size.controlXs,
    color: colors.bodyForeground,
  },
  // The error state: Empty's words, then Try again under them.
  state: {
    display: "grid",
    justifyItems: "center",
    gap: space[3],
    paddingBlockEnd: space[6],
  },
  // A placeholder's line, a line tall, the lead longer than the rest, on its column's side.
  waiting: {
    display: "block",
    height: size.tableTextLine,
    width: "60%",
    overflow: "hidden",
  },
  waitingLead: { width: "80%" },
  waitingEnd: { marginInlineStart: "auto" },
  // A person's cell while loading: a picture's circle and two lines, a line of the text tall each.
  person: { display: "flex", alignItems: "center", gap: space[2], minWidth: 0 },
  personLines: { display: "grid", minWidth: 0 },
  personLine: {
    display: "flex",
    alignItems: "center",
    height: size.tableTextLine,
  },
  // The picture's circle, an sm avatar's, cut from Skeleton's own.
  personPicture: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: size.avatarSm,
    height: size.avatarSm,
    overflow: "hidden",
    borderRadius: radius.circle,
  },
  personName: { width: "8rem" },
  personDetail: { width: "11rem", maxWidth: "100%" },
  // After a column's name: its info and its menu. On a touch screen further off and above the
  // name, so each keeps a finger's 44px.
  after: {
    display: "inline-flex",
    alignItems: "center",
    verticalAlign: "middle",
    marginInlineStart: { default: space[1], [COARSE]: space[3] },
    position: { default: null, [COARSE]: "relative" },
    zIndex: { default: null, [COARSE]: 1 },
    marginInlineEnd: { default: null, [COARSE]: space[1] },
  },
  // The resize handle: a range input at the head's end. Its hairline shows only while the head is
  // under a pointer or the handle is held; the keyboard takes the shared focus ring.
  handle: {
    // A touch screen cannot take an 8px handle: there the column keeps its width.
    display: { default: null, [COARSE]: "none" },
    appearance: "none",
    position: "absolute",
    insetBlock: 0,
    insetInlineEnd: 0,
    zIndex: 1,
    boxSizing: "border-box",
    width: space[2],
    height: "100%",
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    cursor: "col-resize",
    touchAction: "none",
    backgroundImage: {
      default: null,
      ":is(th:hover *)": {
        default: null,
        [HOVER]: endLine(colors.border, "left"),
      },
      ":is([dir=rtl] th:hover *)": {
        default: null,
        [HOVER]: endLine(colors.border, "right"),
      },
    },
    backgroundSize: `100% calc(100% - 2 * ${space[3]})`,
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    "::-webkit-slider-thumb": { appearance: "none", width: 0, height: 0 },
    "::-moz-range-thumb": { width: 0, height: 0, borderWidth: 0 },
  },
  held: { backgroundImage: endLine(colors.pine, "left") },
  // A date's words, the focus ring snug round them; as wide as the widest words, so the row stays.
  date: {
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    borderRadius: radius.sm,
    cornerShape: radius.shape,
  },
  dateRoom: (width: string) => ({ display: "inline-block", minWidth: width }),
});

// ---- The model -----------------------------------------------------------------------------------

type Words = I18nCatalog["dataTable"];
type TableColumn<Row extends RowData> = Column<Features, Row>;
type RowModel<Row extends RowData> = TableRowModel<Features, Row>;

const none: readonly never[] = [];

/** A row's value in a column as words to read: its `text`, else its value. */
const textOf = <Row,>(column: DataTableColumn<Row>, row: Row) =>
  column.text === undefined ? column.value(row) : column.text(row);

const near = (value: number) => Math.round(value);
const px = (value: number) => `${near(value)}px`;

/** One sort, several, or none, as a list. */
const sortList = (
  sort: DataTableSort | readonly DataTableSort[] | undefined
): readonly DataTableSort[] => {
  if (sort === undefined) {
    return none;
  }
  return "key" in sort ? [sort] : sort;
};

// Whether a press had Shift down: it adds a column to the sort, or a range of rows to the selection.
const shifted = (event: unknown) =>
  typeof event === "object" &&
  event !== null &&
  "shiftKey" in event &&
  event.shiftKey === true;

// A token's length in pixels, read from the page.
const lengthOf = (element: Element, name: string, fallback: number) => {
  const value = Number(
    getComputedStyle(element).getPropertyValue(name).replace("px", "")
  );
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** A value the caller may keep in state, else the table keeps it: its value and how to change it. */
const useControlled = <Value,>(
  given: Value | undefined,
  initial: Value | (() => Value),
  onChange: ((next: Value) => void) | undefined
) => {
  const [own, setOwn] = useState(initial);
  const set = (next: Value) => {
    if (given === undefined) {
      setOwn(next);
    }
    onChange?.(next);
  };
  return [given ?? own, set] as const;
};

const flagsOf = <Row,>(props: DataTableProps<Row>) => {
  const features = props.features ?? none;
  return {
    hiding: has(features, "view"),
    resizing: has(features, "resizing"),
    sizing: has(features, "resizing") || has(features, "pinning"),
    ordering: has(features, "ordering"),
    pinning: has(features, "pinning"),
    expanding: has(features, "expanding") || has(features, "grouping"),
    grouping: has(features, "grouping") && props.groupBy !== undefined,
    lead: props.columns[0]?.id,
  };
};

/** Every row's id, its own rows' too. */
const idsOf = <Row,>(
  rows: readonly Row[],
  getRowId: (row: Row) => string,
  getSubRows: ((row: Row) => readonly Row[] | undefined) | undefined
): Set<string> => {
  const ids = new Set<string>();
  const add = (each: readonly Row[]) => {
    for (const row of each) {
      ids.add(getRowId(row));
      add(getSubRows?.(row) ?? none);
    }
  };
  add(rows);
  return ids;
};

/** The state a table keeps itself, or takes from its props where you keep it. */
const useOwnState = <Row,>(props: DataTableProps<Row>) => {
  const { columns } = props;
  const [page, setPage] = useControlled(props.page, 1, props.onPageChange);
  const [sort, setSortOnly] = useControlled<readonly DataTableSort[]>(
    props.sort,
    () => sortList(props.defaultSort),
    (next) => props.onSortChange?.([...next])
  );
  const [query, setQueryOnly] = useControlled(
    props.query,
    "",
    props.onQueryChange
  );
  const [chosen, setSelected] = useControlled<readonly string[]>(
    props.selection,
    props.defaultSelection ?? none,
    (next) => props.onSelectionChange?.([...next])
  );
  // A row that goes (a refetch, an action) leaves the selection, and a selection kept in state is
  // told. A server's table holds one page: a row it does not hold may be on another.
  const known =
    props.rowCount === undefined
      ? idsOf(props.rows, props.getRowId, props.getSubRows)
      : null;
  const selected =
    known === null ? chosen : chosen.filter((id) => known.has(id));
  const gone = selected.length !== chosen.length;
  const prune = useEffectEvent(() => {
    setSelected(selected);
  });
  useEffect(() => {
    if (gone) {
      prune();
    }
  }, [gone]);
  const [collapsed, setCollapsed] = useControlled<readonly string[]>(
    props.collapsedGroups,
    props.defaultCollapsedGroups ?? none,
    (next) => props.onCollapsedGroupsChange?.([...next])
  );
  const [condition, setCondition] =
    useState<DataTableFilterCondition>(noCondition);
  const [hidden, setHidden] = useState<readonly string[]>(() =>
    columns
      .filter((column) => column.hidden === true)
      .map((column) => column.id)
  );
  // Every column the table has known, in its order: one added later goes at the end, hidden if it
  // starts hidden.
  const [order, setOrder] = useState<ColumnOrderState>(() =>
    columns.map((column) => column.id)
  );
  const added = columns.filter((column) => !order.includes(column.id));
  if (added.length > 0) {
    setOrder([...order, ...added.map((column) => column.id)]);
    setHidden([
      ...hidden,
      ...added
        .filter((column) => column.hidden === true)
        .map((column) => column.id),
    ]);
  }
  const [pinned, setPinned] = useState<ColumnPinningState>(() => {
    const lead = columns[0]?.id;
    const pinnedAt = (side: "start" | "end") =>
      columns
        .filter((column) => column.pinned === side && column.id !== lead)
        .map((column) => column.id);
    return {
      start: [
        ...(props.stickyFirstColumn === true && lead !== undefined
          ? [lead]
          : []),
        ...pinnedAt("start"),
      ],
      end: pinnedAt("end"),
    };
  });
  const [widths, setWidths] = useState<ColumnSizingState>({});
  // The reading direction a drag resizes in, read from the page as a handle is pressed.
  const [rtl, setRtl] = useState(false);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  // A new sort, search or filter goes back to page 1.
  const setSort = (next: DataTableSort[]) => {
    setSortOnly(next);
    setPage(1);
  };
  const setQuery = (next: string) => {
    setQueryOnly(next);
    setPage(1);
  };
  const changeCondition = (next: DataTableFilterCondition) => {
    setCondition(next);
    setPage(1);
  };
  return {
    page,
    setPage,
    sort,
    setSort,
    setSortOnly,
    query,
    setQuery,
    setQueryOnly,
    selected,
    setSelected,
    collapsed,
    setCollapsed,
    condition,
    setCondition: changeCondition,
    setConditionOnly: setCondition,
    hidden,
    setHidden,
    order,
    setOrder,
    pinned,
    setPinned,
    widths,
    setWidths,
    rtl,
    setRtl,
    expanded,
    setExpanded,
  };
};
type OwnState = ReturnType<typeof useOwnState>;

/**
 * Sized columns start at the widths their words gave them, measured before the first paint, so
 * nothing moves when the table switches to fixed widths. The checkboxes' column is measured too: a
 * held first column stands that far from the start. The box's width is watched: held columns let
 * go when they would take more than half of it.
 */
const useMeasure = (
  sizing: boolean,
  setWidths: (widths: ColumnSizingState) => void
) => {
  const holder = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<{
    selectWidth: number;
    first: ColumnSizingState;
    narrowest: number;
    step: number;
  }>({ selectWidth: 0, first: {}, narrowest: 64, step: 16 });
  const [boxWidth, setBoxWidth] = useState(0);
  useLayoutEffect(() => {
    const box = holder.current?.querySelector("[data-slot=table-container]");
    const watch = new ResizeObserver(([entry]) => {
      setBoxWidth(near(entry?.contentRect.width ?? 0));
    });
    if (box !== null && box !== undefined) {
      watch.observe(box);
    }
    return () => {
      watch.disconnect();
    };
  }, []);
  useLayoutEffect(() => {
    const element = holder.current;
    if (element === null) {
      return;
    }
    const first: ColumnSizingState = {};
    for (const head of element.querySelectorAll<HTMLElement>(
      "thead th[data-column]"
    )) {
      const { column } = head.dataset;
      if (column !== undefined) {
        first[column] = near(head.getBoundingClientRect().width);
      }
    }
    const select = element.querySelector("thead [data-select]")?.closest("th");
    setMeasured({
      selectWidth: near(select?.getBoundingClientRect().width ?? 0),
      first,
      narrowest: lengthOf(element, "--damsko-table-column-min", 64),
      step: lengthOf(element, "--damsko-table-resize-step", 16),
    });
    if (sizing) {
      setWidths(first);
    }
  }, [sizing, setWidths]);
  return { holder, boxWidth, ...measured };
};

/** The groups' open state as TanStack keeps it (`${column}:${value}`), from those collapsed by value. */
const openState = (
  groupBy: string,
  values: readonly string[],
  collapsed: readonly string[]
): ExpandedState =>
  collapsed.length === 0
    ? true
    : Object.fromEntries(
        values
          .filter((value) => !collapsed.includes(value))
          .map((value) => [`${groupBy}:${value}`, true])
      );

const useTanStack = <Row extends RowData>(
  props: DataTableProps<Row>,
  own: OwnState,
  flags: ReturnType<typeof flagsOf>,
  narrowest: number
) => {
  const total = props.rowCount;
  // Without a page size there are no pages: every row shows, group headings and opened rows too.
  const pageSize = props.pageSize ?? Number.MAX_SAFE_INTEGER;
  const pageNow = Math.min(
    own.page,
    Math.max(1, Math.ceil((total ?? props.rows.length) / pageSize))
  );
  const pagination = { pageIndex: pageNow - 1, pageSize };
  const sorting: SortingState = own.sort.map(({ key, order }) => ({
    id: key,
    desc: order === "descending",
  }));
  const rowSelection: RowSelectionState = Object.fromEntries(
    own.selected.map((id) => [id, true])
  );
  // Grouped, the open rows are the groups, kept by value (collapsedGroups); else rows opened by hand.
  const { groupBy, getSubRows, getRowId } = props;
  const groupColumn = props.columns.find((column) => column.id === groupBy);
  const values =
    groupColumn === undefined
      ? []
      : [...new Set(props.rows.map((row) => String(groupColumn.value(row))))];
  const expanded =
    flags.grouping && groupBy !== undefined
      ? openState(groupBy, values, own.collapsed)
      : own.expanded;
  const state: Partial<TableState<Features>> = {
    sorting,
    globalFilter: own.query,
    pagination,
    rowSelection,
    columnFilters:
      isSet(own.condition) && own.condition.fieldId !== null
        ? [{ id: own.condition.fieldId, value: own.condition }]
        : [],
  };
  // A feature's state is given only while the table holds the feature.
  if (flags.hiding) {
    state.columnVisibility = Object.fromEntries(
      own.hidden.map((id) => [id, false])
    );
  }
  if (flags.ordering) {
    state.columnOrder = own.order;
  }
  if (flags.pinning) {
    state.columnPinning = own.pinned;
  }
  if (flags.sizing) {
    state.columnSizing = own.widths;
  }
  if (flags.expanding) {
    state.expanded = expanded;
  }
  if (flags.grouping && groupBy !== undefined) {
    state.grouping = [groupBy];
  }
  const server = total !== undefined;
  const byId = new Map(props.columns.map((column) => [column.id, column]));
  const table = useTable<Features, Row>({
    features: featuresFor(props.features ?? none),
    columns: props.columns.map((column, index): ColumnDef<Features, Row> => ({
      id: column.id,
      accessorFn: (row: Row) => column.value(row),
      header: column.header,
      enableSorting: column.sortable === true,
      sortDescFirst: false,
      sortFn: (a, b, id) => {
        const [x, y] = [a.getValue(id), b.getValue(id)];
        return typeof x === "number" && typeof y === "number"
          ? x - y
          : asText(x).localeCompare(asText(y), undefined, { numeric: true });
      },
      // The first column names the row: it is never hidden.
      enableHiding: index !== 0,
      enableColumnFilter: column.filter !== false,
      filterFn: (row, id, wanted: DataTableFilterCondition) =>
        passes(row.getValue(id), wanted),
    })),
    // The rows as given: a copy on every render would make TanStack start over.
    data: props.rows,
    getRowId: (row) => getRowId(row),
    state,
    onSortingChange: (updater: Updater<SortingState>) => {
      own.setSort(
        functionalUpdate(updater, sorting).map(({ id, desc }) => ({
          key: id,
          order: desc ? "descending" : "ascending",
        }))
      );
    },
    onGlobalFilterChange: (updater: Updater<string>) => {
      own.setQuery(functionalUpdate(updater, own.query));
    },
    onPaginationChange: (updater) => {
      own.setPage(functionalUpdate(updater, pagination).pageIndex + 1);
    },
    onRowSelectionChange: (updater: Updater<RowSelectionState>) => {
      own.setSelected(
        Object.entries(functionalUpdate(updater, rowSelection))
          .filter(([, on]) => on)
          .map(([id]) => id)
      );
    },
    onColumnVisibilityChange: (updater) => {
      own.setHidden((now) =>
        Object.entries(
          functionalUpdate(
            updater,
            Object.fromEntries(now.map((id) => [id, false]))
          )
        )
          .filter(([, shown]) => !shown)
          .map(([id]) => id)
      );
    },
    onColumnOrderChange: (updater) => {
      own.setOrder((now) => functionalUpdate(updater, now));
    },
    onColumnPinningChange: (updater) => {
      own.setPinned((now) => functionalUpdate(updater, now));
    },
    onColumnSizingChange: (updater) => {
      own.setWidths((now) => functionalUpdate(updater, now));
    },
    onExpandedChange: (updater) => {
      if (flags.grouping && groupBy !== undefined) {
        const next = functionalUpdate(updater, expanded);
        own.setCollapsed(
          next === true
            ? []
            : values.filter((value) => next[`${groupBy}:${value}`] !== true)
        );
      } else {
        own.setExpanded((now) => functionalUpdate(updater, now));
      }
    },
    getSubRows:
      getSubRows === undefined
        ? undefined
        : (row) => [...(getSubRows(row) ?? [])],
    getRowCanExpand:
      props.renderDetailPanel === undefined ? undefined : () => true,
    groupedColumnMode: false,
    columnResizeMode: "onChange",
    columnResizeDirection: own.rtl ? "rtl" : "ltr",
    defaultColumn: { minSize: narrowest },
    globalFilterFn: (row, id, words: string) => {
      const column = byId.get(id);
      return (
        column !== undefined &&
        asText(textOf(column, row.original))
          .toLowerCase()
          .includes(words.trim().toLowerCase())
      );
    },
    getColumnCanGlobalFilter: () => true,
    enableMultiSort: true,
    enableSortingRemoval: false,
    isMultiSortEvent: shifted,
    isRowRangeSelectionEvent: shifted,
    // What is open and which page shows are the person's: a new sort or set of rows keeps them.
    autoResetPageIndex: false,
    autoResetExpanded: false,
    manualSorting: server,
    manualFiltering: server,
    manualPagination: server,
    rowCount: total,
  });
  return { table, pageNow };
};

/** The columns as shown: visible ones, in their order, held start ones first and end ones last. */
const arrange = <Row extends RowData>(
  table: ReturnType<typeof useTanStack<Row>>["table"],
  own: OwnState,
  flags: ReturnType<typeof flagsOf>,
  stickyFirst: boolean
) => {
  const leaves = flags.hiding
    ? table.getVisibleLeafColumns()
    : table.getAllLeafColumns();
  const byId = (ids: readonly string[]) =>
    ids
      .map((id) => leaves.find((column) => column.id === id))
      .filter((column): column is TableColumn<Row> => column !== undefined);
  const lead = stickyFirst && flags.lead !== undefined ? [flags.lead] : [];
  const startIds = flags.pinning ? (own.pinned.start ?? []) : lead;
  const endIds = flags.pinning ? (own.pinned.end ?? []) : [];
  const middle = (flags.ordering ? byId(own.order) : leaves).filter(
    (column) => !startIds.includes(column.id) && !endIds.includes(column.id)
  );
  return { start: byId(startIds), middle, end: byId(endIds) };
};

/** The model the parts draw from, and the ref of the box it measures. */
const useDataTable = <Row extends RowData>(props: DataTableProps<Row>) => {
  const flags = flagsOf(props);
  const own = useOwnState(props);
  const measure = useMeasure(flags.sizing, own.setWidths);
  const { table, pageNow } = useTanStack(props, own, flags, measure.narrowest);
  const selectable = props.selectable === true;
  const { start, middle, end } = arrange(
    table,
    own,
    flags,
    props.stickyFirstColumn === true
  );
  const shown = [...start, ...middle, ...end];

  const sized = flags.sizing && Object.keys(own.widths).length > 0;
  const widthOf = (id: string) =>
    flags.sizing ? (ownValue(own.widths, id) ?? 0) : 0;
  const select = selectable ? measure.selectWidth : 0;
  // Held columns need room beside them: where they would take more than half the box (a phone),
  // nothing is held and the whole table scrolls.
  const heldWidth =
    [...start, ...end].reduce(
      (sum, column) =>
        sum +
        (sized
          ? widthOf(column.id)
          : (ownValue(measure.first, column.id) ?? 0)),
      0
    ) + (start.length > 0 ? select : 0);
  const room = measure.boxWidth === 0 || heldWidth <= measure.boxWidth / 2;
  const measured = room && (measure.selectWidth > 0 || !selectable);
  const sum = (columns: readonly TableColumn<Row>[]) =>
    columns.reduce((total, column) => total + widthOf(column.id), 0);
  // Where a held column stands: past the checkboxes and the held columns before it.
  const pinOf = (id: string): TablePin | undefined => {
    const at = start.findIndex((column) => column.id === id);
    const from = end.findIndex((column) => column.id === id);
    if (!measured || (at === -1 && from === -1)) {
      return undefined;
    }
    return at === -1
      ? { side: "end", offset: px(sum(end.slice(from + 1))), edge: from === 0 }
      : {
          side: "start",
          offset: px(select + sum(start.slice(0, at))),
          edge: at === start.length - 1,
        };
  };

  const columnOf = (id: string) =>
    props.columns.find((column) => column.id === id);
  const drop = (from: string, onto: string, side: "before" | "after") => {
    if (from === onto) {
      return;
    }
    const next = own.order.filter((each) => each !== from);
    next.splice(next.indexOf(onto) + (side === "after" ? 1 : 0), 0, from);
    table.setColumnOrder(next);
  };
  // A column moves past the next column that scrolls with it: a held or hidden one is not in its way.
  const move = (id: string, side: "before" | "after") => {
    const free = middle.map((column) => column.id);
    const beside = free[free.indexOf(id) + (side === "after" ? 1 : -1)];
    if (free.includes(id) && beside !== undefined) {
      drop(id, beside, side);
    }
  };
  const sortAt = (id: string) => own.sort.findIndex((each) => each.key === id);
  const [first] = props.columns;
  const selectedIds = new Set(own.selected);

  // State is read from here, never through a row's or a column's own methods: TanStack keeps those
  // objects as they are while their state changes, so a part given one would not know.
  return {
    holder: measure.holder,
    model: {
      table,
      own,
      flags,
      shown,
      sized,
      widthOf,
      pinOf,
      move,
      drop,
      columnOf,
      pageNow,
      firstWidths: measure.first,
      narrowest: measure.narrowest,
      step: measure.step,
      selectWidth: measure.selectWidth,
      tableWidth: sized ? sum(shown) + select : undefined,
      holds: room && start.length + end.length > 0,
      selectPin:
        start.length > 0 && measured && selectable
          ? ({
              side: "start",
              offset: px(0),
              edge: false,
              above: true,
            } as const)
          : undefined,
      filtered: isSet(own.condition),
      isSelected: (id: string) => selectedIds.has(id),
      // Open is TanStack's own answer, asked through the table, whose reference renews on a change.
      isOpen: (id: string) =>
        flags.expanding && table.getRow(id, true).getIsExpanded(),
      sortOf: (id: string) => own.sort[sortAt(id)]?.order,
      sortPlace: (id: string) => sortAt(id) + 1,
      resizing: flags.resizing
        ? table.state.columnResizing.isResizingColumn
        : false,
      name: (row: RowModel<Row>) =>
        first === undefined ? row.id : String(first.value(row.original)),
      // The rows found, every page, without the groups' heading rows.
      found: () =>
        table
          .getPrePaginatedRowModel()
          .flatRows.filter((row) => !flags.grouping || !row.getIsGrouped()),
      span: shown.length + (selectable ? 1 : 0) + (props.rowActions ? 1 : 0),
    },
  };
};
type Model<Row extends RowData> = ReturnType<typeof useDataTable<Row>>["model"];

/** What the table's hooks read while it draws: the model, the props, the words, a row's name. */
interface View<Row extends RowData> {
  model: Model<Row>;
  props: DataTableProps<Row>;
  words: Words;
  unit: DataTableUnit;
}

/** What every part draws from: the view, and what a part does. */
interface Ctx<Row extends RowData> extends View<Row> {
  /** Does a row's action, keeping focus in the table if the action takes the row away. */
  onRowAction: (id: string, action: DataTableRowAction) => void;
}

// ---- The view in a link --------------------------------------------------------------------------

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

const viewOf = <Row extends RowData>({
  model,
  props,
}: View<Row>): DataTableView => {
  const { own, flags } = model;
  const { fieldId, operatorId, value } = own.condition;
  const startHidden = props.columns
    .filter((column) => column.hidden === true)
    .map((column) => column.id);
  const pinned = { start: own.pinned.start ?? [], end: own.pinned.end ?? [] };
  return {
    sort:
      own.sort.length > 0 && !same(own.sort, sortList(props.defaultSort))
        ? [...own.sort]
        : undefined,
    query: own.query === "" ? undefined : own.query,
    filter:
      model.filtered &&
      fieldId !== null &&
      operatorId !== null &&
      value !== null
        ? { field: fieldId, operator: operatorId, value }
        : undefined,
    page: model.pageNow > 1 ? model.pageNow : undefined,
    hidden:
      flags.hiding && !same(own.hidden, startHidden)
        ? [...own.hidden]
        : undefined,
    order:
      flags.ordering &&
      !same(
        own.order,
        props.columns.map((column) => column.id)
      )
        ? own.order
        : undefined,
    pinned:
      flags.pinning && pinned.start.length + pinned.end.length > 0
        ? pinned
        : undefined,
    collapsed:
      flags.grouping && own.collapsed.length > 0
        ? [...own.collapsed]
        : undefined,
  };
};

/**
 * The view, in a link: read from the location when the table opens (before the first paint, so a
 * collapsed group never shows open) and on Back and Forward, and written as it changes. The first
 * write waits for the view read to be in place.
 */
const useView = <Row extends RowData>(ctx: View<Row>) => {
  const { location, columns, defaultSort } = ctx.props;
  const { own, flags } = ctx.model;
  const readRef = useRef<"none" | "read" | "done">("none");
  const lastRef = useRef("");
  // Only what differs is set, so a table kept in state (a server's) is told of a real change alone,
  // and fetches once.
  const apply = useEffectEvent((view: DataTableView) => {
    const sort = view.sort ?? [...sortList(defaultSort)];
    if (!same(sort, own.sort)) {
      own.setSortOnly(sort);
    }
    const query = view.query ?? "";
    if (query !== own.query) {
      own.setQueryOnly(query);
    }
    const condition =
      view.filter === undefined
        ? noCondition
        : {
            fieldId: view.filter.field,
            operatorId: view.filter.operator,
            value: view.filter.value,
          };
    if (!same(condition, own.condition)) {
      own.setConditionOnly(condition);
    }
    const page = view.page ?? 1;
    if (page !== own.page) {
      own.setPage(page);
    }
    const ids = columns.map((column) => column.id);
    if (flags.hiding) {
      own.setHidden(
        view.hidden ??
          columns.filter((column) => column.hidden === true).map((c) => c.id)
      );
    }
    if (flags.ordering) {
      const known = (view.order ?? []).filter((id) => ids.includes(id));
      own.setOrder([...known, ...ids.filter((id) => !known.includes(id))]);
    }
    if (flags.pinning && view.pinned !== undefined) {
      own.setPinned(view.pinned);
    }
    const collapsed = view.collapsed ?? [];
    if (flags.grouping && !same(collapsed, own.collapsed)) {
      own.setCollapsed(collapsed);
    }
  });
  useLayoutEffect(() => {
    if (location !== undefined) {
      apply(location.read());
      readRef.current = "read";
    }
    const stop = location?.listen(() => {
      apply(location.read());
    });
    return () => {
      stop?.();
    };
  }, [location]);
  const key = JSON.stringify(viewOf(ctx));
  const write = useEffectEvent(() => {
    location?.write(viewOf(ctx));
  });
  useEffect(() => {
    if (readRef.current === "read") {
      readRef.current = "done";
      lastRef.current = key;
    } else if (readRef.current === "done" && lastRef.current !== key) {
      lastRef.current = key;
      write();
    }
  }, [key]);
};

// ---- Endless loading, and the table's height while rows load -------------------------------------

/** The mark under the last row coming into view asks for more, while more can come. */
const useEnd = <Row extends RowData>({ props }: View<Row>) => {
  const endRef = useRef<HTMLDivElement>(null);
  const watching =
    props.hasMore === true &&
    props.loadingMore !== true &&
    props.loading !== true;
  const inBox = props.height !== undefined;
  const count = props.rows.length;
  const reach = useEffectEvent(() => {
    props.onEndReached?.();
  });
  useEffect(() => {
    const element = endRef.current;
    const watch = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting === true) {
          reach();
        }
      },
      {
        root: inBox ? element?.closest("[data-slot=table-container]") : null,
        rootMargin: "0px 0px 160px 0px",
      }
    );
    if (element !== null && watching && count > 0) {
      watch.observe(element);
    }
    return () => {
      watch.disconnect();
    };
  }, [watching, inBox, count]);
  return endRef;
};

/**
 * While rows are on their way the table stands as tall as it last did, so nothing under it moves;
 * rows that replace their placeholders fade in, rows there from the first paint do not.
 */
const useLoading = (
  holder: { current: HTMLElement | null },
  loading: boolean
) => {
  const last = useRef(0);
  const [kept, setKept] = useState<number | null>(null);
  const [was, setWas] = useState(loading);
  const [arrived, setArrived] = useState(false);
  if (was !== loading) {
    setWas(loading);
    setArrived(was);
  }
  useLayoutEffect(() => {
    if (!loading) {
      last.current =
        holder.current?.querySelector<HTMLElement>(
          "[data-slot=table-container]"
        )?.offsetHeight ?? 0;
    }
  });
  useLayoutEffect(() => {
    setKept(loading && last.current > 0 ? last.current : null);
  }, [loading]);
  return { kept, arrived: arrived && !loading };
};

// ---- The agent bridge ----------------------------------------------------------------------------

// What an agent may ask of the table, through the page's one agent bridge (UI SDK's createAgent): a
// part named after the table, whose actions read its columns and rows and change the view as a
// person can. Each answers with plain data, or `{ error }`, in English, for the agent.
interface Tools {
  read: (input?: { offset?: number }) => unknown;
  sortBy: (input: {
    key: string;
    order?: "ascending" | "descending";
    add?: boolean;
  }) => unknown;
  search: (input: { query: string }) => unknown;
  filter: (
    input: { field: string; operator: string; value: string | number } | null
  ) => unknown;
  choose: (input: { keys: string[] }) => unknown;
  page: (input: { page: number }) => unknown;
}
type Ask<Name extends keyof Tools> = Parameters<Tools[Name]>[0];

const toolNames = [
  "read",
  "sortBy",
  "search",
  "filter",
  "choose",
  "page",
] as const;

const dataTableAgent = definePrimitive({
  name: "data-table",
  options: { tools: "value" },
  state: (_options: { tools?: Tools }) => ({}),
  api: (context) => {
    const ask = (run: (tools: Tools) => unknown) => {
      const { tools } = context.options();
      return tools === undefined
        ? { error: "The table is not ready yet." }
        : run(tools);
    };
    return {
      read: (input?: Ask<"read">) => ask((tools) => tools.read(input)),
      sortBy: (input: Ask<"sortBy">) => ask((tools) => tools.sortBy(input)),
      search: (input: Ask<"search">) => ask((tools) => tools.search(input)),
      filter: (input: Ask<"filter">) => ask((tools) => tools.filter(input)),
      choose: (input: Ask<"choose">) => ask((tools) => tools.choose(input)),
      page: (input: Ask<"page">) => ask((tools) => tools.page(input)),
    };
  },
  slots: (slot) => ({ root: slot({}) }),
  agent: { actions: [...toolNames] },
});

const toolsFor = <Row extends RowData>(
  { model, props }: View<Row>,
  fields: readonly DataTableFilterField[]
): Tools => {
  const { table, own } = model;
  const columns = props.columns.map((column) => ({
    key: column.id,
    header: column.header,
    sortable: column.sortable === true,
    filterable: props.filterable === true && column.filter !== false,
  }));
  // How many rows there are in all: a server's count, else the rows found here.
  const total = () => props.rowCount ?? model.found().length;
  const pages = () =>
    Math.max(1, Math.ceil(total() / (props.pageSize ?? Math.max(1, total()))));
  const most = 200;
  return {
    read: (input) => {
      const offset = Math.max(0, input?.offset ?? 0);
      const rows = model.found();
      const given = rows.slice(offset, offset + most);
      return {
        label: props["aria-label"],
        columns,
        rows: given.map((row) => ({
          key: row.id,
          chosen: model.isSelected(row.id),
          values: Object.fromEntries(
            props.columns.map((column) => [
              column.id,
              column.value(row.original),
            ])
          ),
        })),
        found: total(),
        offset,
        more: offset + given.length < total(),
        view: {
          sort: own.sort,
          query: own.query,
          filter: own.condition,
          page: model.pageNow,
          pages: pages(),
        },
      };
    },
    sortBy: ({ key, order, add = false }) => {
      if (props.columns.find((each) => each.id === key)?.sortable !== true) {
        const sortable = columns.filter((each) => each.sortable);
        return {
          error: `No sortable column "${key}". Sortable: ${sortable.map((each) => each.key).join(", ")}.`,
        };
      }
      table
        .getColumn(key)
        ?.toggleSorting(
          order === undefined ? undefined : order === "descending",
          add
        );
      return { sorted: key };
    },
    search: ({ query }) => {
      if (props.searchable !== true) {
        return { error: "This table has no search." };
      }
      table.setGlobalFilter(query);
      return { query };
    },
    filter: (input) => {
      if (props.filterable !== true) {
        return { error: "This table has no filter." };
      }
      if (input === null) {
        own.setCondition(noCondition);
        return { filter: null };
      }
      const field = fields.find((each) => each.id === input.field);
      if (field === undefined) {
        return {
          error: `No filter on "${input.field}". Fields: ${fields.map((each) => each.id).join(", ")}.`,
        };
      }
      if (!field.operators.some((each) => each.id === input.operator)) {
        return {
          error: `"${input.operator}" is not an operator of ${field.id}: ${field.operators.map((each) => each.id).join(", ")}.`,
        };
      }
      own.setCondition({
        fieldId: input.field,
        operatorId: input.operator,
        value: input.value,
      });
      return { filter: input };
    },
    choose: ({ keys }) => {
      if (props.selectable !== true) {
        return { error: "Rows cannot be selected in this table." };
      }
      const known = new Set(model.found().map((row) => row.id));
      const unknown = keys.filter((key) => !known.has(key));
      if (unknown.length > 0) {
        return { error: `No rows with the keys ${unknown.join(", ")}.` };
      }
      own.setSelected([...keys]);
      return { chosen: keys };
    },
    page: ({ page }) => {
      if (!Number.isInteger(page) || page < 1 || page > pages()) {
        return { error: `There are pages 1 to ${String(pages())}.` };
      }
      table.setPageIndex(page - 1);
      return { page };
    },
  };
};

// ---- The bar -------------------------------------------------------------------------------------

/** A Checkbox with its words hidden and its 44px reach spilling into the next cell. */
const SelectBox = ({
  name,
  checked,
  disabled = false,
  onPress,
  onChange,
}: {
  name: string;
  checked: CheckedState;
  disabled?: boolean;
  onPress?: (shiftKey: boolean) => void;
  onChange: (checked: boolean) => void;
}) => (
  <span data-select="" {...stylex.props(styles.pick)}>
    <span {...stylex.props(styles.reach)}>
      <span {...stylex.props(styles.lift)}>
        <Field orientation="horizontal" disabled={disabled}>
          <Checkbox
            checked={checked}
            onClick={(event) => {
              onPress?.(event.shiftKey);
            }}
            onCheckedChange={(next) => {
              onChange(next === true);
            }}
          />
          <FieldLabel>
            <span {...stylex.props(styles.pickWords)}>{name}</span>
          </FieldLabel>
        </Field>
      </span>
    </span>
  </span>
);

const ViewMenu = <Row extends RowData>({
  ctx: { model, words },
  atEnd,
}: {
  ctx: Ctx<Row>;
  atEnd: boolean;
}) => (
  <DropdownMenu>
    <span {...stylex.props(atEnd && styles.atEnd)}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          <Icon icon={SlidersHorizontalIcon} />
          {words.view}
        </Button>
      </DropdownMenuTrigger>
    </span>
    <DropdownMenuContent align="end">
      <DropdownMenuGroup>
        <DropdownMenuLabel>{words.columns}</DropdownMenuLabel>
        {model.table.getAllLeafColumns().map((column) => (
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={!model.own.hidden.includes(column.id)}
            disabled={!column.getCanHide()}
            onCheckedChange={(next) => {
              column.toggleVisibility(next);
            }}
          >
            {model.columnOf(column.id)?.header ?? column.id}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
);

/** The selected rows' count, and what can be done to them while some are selected. */
const Selected = <Row extends RowData>({
  ctx: { model, props, words, unit },
  onAct,
  onAsk,
}: {
  ctx: Ctx<Row>;
  onAct: (action: DataTableAction) => void;
  onAsk: (action: DataTableAction) => void;
}) => {
  const count = (
    <span
      aria-live="polite"
      {...stylex.props(
        styles.count,
        props.loading === true && styles.countWaiting
      )}
    >
      {words.selected(
        model.own.selected.length,
        props.rowCount ?? props.rows.length
      )}
    </span>
  );
  const actions = props.actions ?? none;
  if (model.own.selected.length === 0 || actions.length === 0) {
    return count;
  }
  return (
    <fieldset
      aria-label={words.withChosen(unit.other)}
      {...stylex.props(styles.bulk)}
    >
      {count}
      {actions.map((action) => {
        const content = (
          <>
            {action.icon && <Icon icon={action.icon} />}
            {action.label}
          </>
        );
        return action.severity === "moderate" ? (
          <HoldButton
            key={action.label}
            variant="destructive"
            onConfirm={() => {
              onAct(action);
            }}
          >
            {content}
          </HoldButton>
        ) : (
          <Button
            key={action.label}
            variant={action.severity === "grave" ? "destructive" : "outline"}
            onClick={() => {
              (action.severity === "grave" ? onAsk : onAct)(action);
            }}
          >
            {content}
          </Button>
        );
      })}
      <Button
        variant="outline"
        onClick={() => {
          model.table.resetRowSelection(true);
        }}
      >
        {words.clear}
      </Button>
    </fieldset>
  );
};

const Bar = <Row extends RowData>({
  ctx,
  fields,
  onAct,
  onAsk,
  onExport,
}: {
  ctx: Ctx<Row>;
  fields: readonly DataTableFilterField[];
  onAct: (action: DataTableAction) => void;
  onAsk: (action: DataTableAction) => void;
  onExport: () => void;
}) => {
  const { model, props, words, unit } = ctx;
  const label = props["aria-label"];
  const selectable = props.selectable === true;
  const exportable = props.exportFileName !== undefined;
  return (
    <div {...stylex.props(styles.bar)}>
      {props.searchable === true && (
        <div {...stylex.props(styles.search)}>
          <InputGroup>
            <InputGroupAddon>
              <Icon icon={SearchIcon} />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label={words.searchLabel(label)}
              placeholder={words.search(unit.other)}
              value={model.own.query}
              onValueChange={(value: string) => {
                model.table.setGlobalFilter(value);
              }}
            />
            <InputGroupClear aria-label={words.clearSearch} />
          </InputGroup>
        </div>
      )}
      {props.filterable === true && (
        <DataTableFilters
          fields={fields}
          condition={model.own.condition}
          onConditionChange={(next) => {
            model.own.setCondition(next);
          }}
          aria-label={words.filterLabel(label)}
        />
      )}
      {selectable && <Selected ctx={ctx} onAct={onAct} onAsk={onAsk} />}
      {exportable && (
        // At the end with View beside it; where the count stands before it, the count already
        // takes the bar to its end.
        <span {...stylex.props(!selectable && styles.atEnd)}>
          <Button variant="outline" onClick={onExport}>
            <Icon icon={DownloadIcon} />
            {words.exportCsv}
          </Button>
        </span>
      )}
      {model.flags.hiding && (
        <ViewMenu ctx={ctx} atEnd={!exportable && !selectable} />
      )}
    </div>
  );
};

// ---- The head ------------------------------------------------------------------------------------

type Side = "before" | "after";

const sideOf = (event: DragEvent<HTMLTableCellElement>): Side => {
  const box = event.currentTarget.getBoundingClientRect();
  const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
  return event.clientX < box.left + box.width / 2 === rtl ? "after" : "before";
};

const item = (
  key: string,
  label: string,
  run: () => void,
  disabled = false
) => (
  <DropdownMenuItem key={key} disabled={disabled} onSelect={run}>
    {label}
  </DropdownMenuItem>
);

/** A column's menu: sort, hold, move and hide, as far as the table's features reach. */
const ColumnMenu = <Row extends RowData>({
  ctx: { model, words },
  column,
  header,
}: {
  ctx: Ctx<Row>;
  column: TableColumn<Row>;
  header: string;
}) => {
  const pinnedAt = (["start", "end"] as const).find((side) =>
    (model.own.pinned[side] ?? []).includes(column.id)
  );
  const index = model.own.order.indexOf(column.id);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={words.columnMenu(header)}
        >
          <Icon icon={EllipsisIcon} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{header}</DropdownMenuLabel>
          {column.getCanSort() && [
            item("up", words.sortUp, () => {
              column.toggleSorting(false, false);
            }),
            item("down", words.sortDown, () => {
              column.toggleSorting(true, false);
            }),
            model.own.sort.length > 0 &&
              model.sortOf(column.id) === undefined &&
              item("next", words.sortNext, () => {
                column.toggleSorting(false, true);
              }),
          ]}
        </DropdownMenuGroup>
        {model.flags.pinning && (
          <>
            <DropdownMenuSeparator />
            {pinnedAt !== "start" &&
              item("start", words.pinStart, () => {
                column.pin("start");
              })}
            {pinnedAt !== "end" &&
              item("end", words.pinEnd, () => {
                column.pin("end");
              })}
            {pinnedAt !== undefined &&
              item("unpin", words.unpin, () => {
                column.pin(false);
              })}
          </>
        )}
        {model.flags.ordering && (
          <>
            <DropdownMenuSeparator />
            {item(
              "earlier",
              words.moveEarlier,
              () => {
                model.move(column.id, "before");
              },
              index <= 0
            )}
            {item(
              "later",
              words.moveLater,
              () => {
                model.move(column.id, "after");
              },
              index >= model.own.order.length - 1
            )}
          </>
        )}
        {model.flags.hiding && column.getCanHide() && (
          <>
            <DropdownMenuSeparator />
            {item("hide", words.hide, () => {
              column.toggleVisibility(false);
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

// The widest a column can be made with the keys.
const WIDEST = 1200;

/**
 * The handle at a sized column's head: a range input, a real control a screen reader and the keys
 * know. Dragged it resizes the column as TanStack measures; the arrow keys move it a step at a
 * time; a double press puts the column back to its first width.
 */
const ResizeHandle = <Row extends RowData>({
  ctx: { model, words },
  column,
  header,
}: {
  ctx: Ctx<Row>;
  column: TableColumn<Row>;
  header: string;
}) => {
  const width = model.widthOf(column.id);
  const setWidth = (next: number) => {
    model.own.setWidths((now) => ({ ...now, [column.id]: next }));
  };
  const handleStart = (
    event: MouseEvent<HTMLInputElement> | TouchEvent<HTMLInputElement>
  ) => {
    // The pointer resizes as TanStack measures it, not as a range would slide; right to left, a
    // drag toward the start of the line widens the column.
    event.preventDefault();
    model.own.setRtl(getComputedStyle(event.currentTarget).direction === "rtl");
    model.table
      .getFlatHeaders()
      .find((each) => each.column.id === column.id)
      ?.getResizeHandler()(event);
  };
  return (
    <input
      type="range"
      aria-label={words.width(header)}
      min={model.narrowest}
      max={Math.max(WIDEST, width)}
      step={model.step}
      value={width}
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        setWidth(Math.max(model.narrowest, Number(event.currentTarget.value)));
      }}
      onMouseDown={handleStart}
      onTouchStart={handleStart}
      onDoubleClick={() => {
        setWidth(ownValue(model.firstWidths, column.id) ?? width);
      }}
      {...stylex.props(
        styles.handle,
        model.resizing === column.id && styles.held,
        focusRingInset
      )}
    />
  );
};

/** What stands after a column's name: its info mark, its menu, its resize handle. */
const HeadEnd = <Row extends RowData>({
  ctx,
  column,
  header,
}: {
  ctx: Ctx<Row>;
  column: TableColumn<Row>;
  header: string;
}) => {
  const { flags, sized } = ctx.model;
  const description = ctx.model.columnOf(column.id)?.description;
  const menu = flags.hiding || flags.ordering || flags.pinning;
  return (
    <>
      {description !== undefined && (
        <span {...stylex.props(styles.after, ringInsetMarker)}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={ctx.words.columnInfo(header)}
              >
                <Icon icon={InfoIcon} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{description}</TooltipContent>
          </Tooltip>
        </span>
      )}
      {menu && (
        <span {...stylex.props(styles.after, ringInsetMarker)}>
          <ColumnMenu ctx={ctx} column={column} header={header} />
        </span>
      )}
      {flags.resizing && sized && (
        <ResizeHandle ctx={ctx} column={column} header={header} />
      )}
    </>
  );
};

// The checkbox's column where the table lays itself out: a width it cannot fit, so it is as narrow
// as its box. Left to share the table's spare room it grew wide.
const NARROW = 1;

const HeadRow = <Row extends RowData>({ ctx }: { ctx: Ctx<Row> }) => {
  const { model, props, words, unit } = ctx;
  const [dropAt, setDropAt] = useState<{ id: string; side: Side } | null>(null);
  const fromRef = useRef<string | null>(null);
  const { rows } = model.table.getRowModel();
  const selectedHere = rows.filter((row) => model.isSelected(row.id)).length;
  let all: CheckedState = "indeterminate";
  if (selectedHere === 0) {
    all = false;
  } else if (selectedHere === rows.length) {
    all = true;
  }
  const sortCount = model.own.sort.length;
  const { flags } = model;
  // Dragging a head moves its column, with the ordering feature.
  const dragOf = (id: string) =>
    flags.ordering
      ? {
          draggable: true,
          onDragStart: (event: DragEvent<HTMLTableCellElement>) => {
            fromRef.current = id;
            event.dataTransfer.effectAllowed = "move";
          },
          onDragOver: (event: DragEvent<HTMLTableCellElement>) => {
            event.preventDefault();
            const side = sideOf(event);
            if (dropAt?.id !== id || dropAt.side !== side) {
              setDropAt({ id, side });
            }
          },
          onDragLeave: () => {
            setDropAt(null);
          },
          onDrop: (event: DragEvent<HTMLTableCellElement>) => {
            event.preventDefault();
            if (fromRef.current !== null) {
              model.drop(fromRef.current, id, sideOf(event));
            }
            fromRef.current = null;
            setDropAt(null);
          },
          onDragEnd: () => {
            fromRef.current = null;
            setDropAt(null);
          },
          "data-drop": dropAt?.id === id ? dropAt.side : undefined,
        }
      : undefined;
  // Whether a head holds anything after its name: its info, its menu, its resize handle.
  const endsAt = (description: string | undefined) =>
    flags.hiding ||
    flags.ordering ||
    flags.pinning ||
    (flags.resizing && model.sized) ||
    description !== undefined;
  return (
    <TableRow>
      {props.selectable === true && (
        <TableHead
          aria-label={words.chooseColumn}
          pin={model.selectPin}
          width={model.sized ? model.selectWidth : NARROW}
        >
          <SelectBox
            name={words.chooseAll(unit.one)}
            checked={all}
            disabled={rows.length === 0}
            onChange={(next) => {
              model.table.toggleAllPageRowsSelected(next);
            }}
          />
        </TableHead>
      )}
      {model.shown.map((column) => {
        const meta = model.columnOf(column.id);
        const header = meta?.header ?? column.id;
        const sortable = column.getCanSort();
        const at = model.sortOf(column.id);
        return (
          <TableHead
            key={column.id}
            align={meta?.align}
            sortDirection={sortable ? (at ?? "none") : undefined}
            sortIndex={
              sortCount > 1 && at !== undefined
                ? model.sortPlace(column.id)
                : undefined
            }
            onSort={
              sortable
                ? (event) => {
                    column.toggleSorting(
                      undefined,
                      event.shiftKey &&
                        sortCount > 0 &&
                        column.getCanMultiSort()
                    );
                  }
                : undefined
            }
            pin={model.pinOf(column.id)}
            width={model.sized ? model.widthOf(column.id) : undefined}
            actions={
              endsAt(meta?.description) ? (
                <HeadEnd ctx={ctx} column={column} header={header} />
              ) : undefined
            }
            column={column.id}
            hideBelow={meta?.hideBelow}
            drag={dragOf(column.id)}
          >
            {header}
          </TableHead>
        );
      })}
      {props.rowActions !== undefined && (
        <TableHead aria-label={words.actions} />
      )}
    </TableRow>
  );
};

// ---- The rows ------------------------------------------------------------------------------------

const detailId = (id: string) => `${id}-detail`;

/** Opens and closes a row's detail, its own rows, or a group. */
const Toggle = ({
  open,
  name,
  words,
  controls,
  onToggle,
}: {
  /** Open now: given, not asked of the row, whose own answer a part would not see change. */
  open: boolean;
  name: string;
  words: Words;
  controls?: string;
  onToggle: () => void;
}) => (
  <span {...stylex.props(styles.inRow)}>
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={open ? words.close(name) : words.open(name)}
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      onClick={onToggle}
    >
      <Icon icon={open ? ChevronDownIcon : ChevronRightIcon} />
    </Button>
  </span>
);

/** A group's heading: its toggle, the value its rows share, and how many they are. */
const GroupRow = <Row extends RowData>({
  ctx: { model, props, words },
  row,
  groupBy,
}: {
  ctx: Ctx<Row>;
  row: RowModel<Row>;
  groupBy: string;
}) => {
  const value = String(row.getGroupingValue(groupBy));
  const variant = props.getGroupVariant?.(value);
  return (
    <TableRow>
      <TableCell colSpan={model.span} rowHeader sticky>
        <span data-slot="data-table-group" {...stylex.props(styles.group)}>
          <Toggle
            open={model.isOpen(row.id)}
            name={`${model.columnOf(groupBy)?.header ?? groupBy}: ${value}`}
            words={words}
            onToggle={() => {
              row.toggleExpanded();
            }}
          />
          <span>{value}</span>
          <Badge variant={variant ?? "default"} size="sm">
            <span {...stylex.props(styles.figures)}>
              {row.getLeafRows().length}
            </span>
          </Badge>
          {variant === "warning" && (
            <span
              {...stylex.props(visuallyHidden)}
            >{`, ${words.groupAttention}`}</span>
          )}
        </span>
      </TableCell>
    </TableRow>
  );
};

/** The lead cell's words as the row's target: a link, or a button, drawn as the cell's plain text. */
const RowTarget = <Row extends RowData>({
  props,
  row,
  children,
}: {
  props: DataTableProps<Row>;
  row: Row;
  children: ReactNode;
}) => {
  const { getRowHref, onRowClick } = props;
  return getRowHref === undefined ? (
    <button
      type="button"
      data-row-target=""
      onClick={() => {
        onRowClick?.(row);
      }}
      {...stylex.props(styles.rowTarget)}
    >
      {children}
    </button>
  ) : (
    <a
      href={getRowHref(row)}
      data-row-target=""
      {...stylex.props(styles.rowTarget)}
    >
      {children}
    </a>
  );
};

/** One cell of a row of data: its value, the row's target in the lead cell, a toggle that opens it. */
const DataCell = <Row extends RowData>({
  ctx: { model, props, words },
  row,
  id,
  opens,
  status,
  detail,
}: {
  ctx: Ctx<Row>;
  row: RowModel<Row>;
  id: string;
  opens: boolean;
  status: "pending" | "removed" | undefined;
  detail: boolean;
}) => {
  const meta = model.columnOf(id);
  if (meta === undefined) {
    return null;
  }
  const { flags } = model;
  const value =
    meta.cell === undefined
      ? meta.value(row.original)
      : meta.cell(row.original);
  const lead = id === flags.lead;
  const content =
    opens && lead ? (
      <RowTarget props={props} row={row.original}>
        {value}
      </RowTarget>
    ) : (
      value
    );
  // The lead cell steps in for a deeper row, and holds a toggle in a table whose rows open. A
  // group's rows stand on the columns' own lines: the group's toggle is in its heading.
  const opener = lead && !flags.grouping && (flags.expanding || row.depth > 0);
  // A control in the cell, or a Badge (which sat off the baseline), stands in a box one line tall,
  // so the row keeps its height.
  const inLine =
    meta.control === true || (isValidElement(value) && value.type === Badge);
  let shown: ReactNode = content;
  if (opener) {
    shown = (
      <span {...stylex.props(styles.opener, styles.depth(row.depth))}>
        {flags.expanding && row.getCanExpand() ? (
          <Toggle
            open={model.isOpen(row.id)}
            name={model.name(row)}
            words={words}
            controls={detail ? detailId(row.id) : undefined}
            onToggle={() => {
              row.toggleExpanded();
            }}
          />
        ) : (
          <span {...stylex.props(styles.toggleRoom)} />
        )}
        <span {...stylex.props(styles.nowrap)}>{content}</span>
      </span>
    );
  } else if (inLine) {
    shown = <span {...stylex.props(styles.inLine)}>{content}</span>;
  }
  return (
    <TableCell
      rowHeader={lead}
      align={meta.align}
      wrap={meta.wrap === true}
      pin={model.pinOf(id)}
      truncate={model.sized}
      title={String(textOf(meta, row.original))}
      hideBelow={meta.hideBelow}
    >
      {shown}
      {lead && status !== undefined && (
        <span {...stylex.props(visuallyHidden)}>
          {`, ${status === "pending" ? words.rowPending : words.rowRemoved}`}
        </span>
      )}
    </TableCell>
  );
};

/** A row of data, and its detail under it while it is open. */
const DataRow = <Row extends RowData>({
  ctx,
  row,
  kept = false,
}: {
  ctx: Ctx<Row>;
  row: RowModel<Row>;
  /** Kept only for the column widths it gives, while a search or a filter matches no row. */
  kept?: boolean;
}) => {
  const { model, props, words } = ctx;
  const shiftRef = useRef(false);
  const live = !kept;
  const status = live ? props.getRowStatus?.(row.original) : undefined;
  const opens =
    live && (props.getRowHref !== undefined || props.onRowClick !== undefined);
  const detail = live ? props.renderDetailPanel : undefined;
  const selected = model.isSelected(row.id);
  const name = model.name(row);
  return (
    <>
      <TableRow
        selected={selected}
        open={live}
        status={status}
        interactive={opens}
        current={live && props.isRowActive?.(row.original) === true}
      >
        {props.selectable === true && (
          <TableCell pin={model.selectPin}>
            <span {...stylex.props(opens && styles.above)}>
              <SelectBox
                name={words.select(name)}
                checked={selected}
                onPress={(shiftKey) => {
                  shiftRef.current = shiftKey;
                }}
                onChange={(next) => {
                  row.getToggleSelectedHandler()({
                    target: { checked: next },
                    shiftKey: shiftRef.current,
                  });
                  shiftRef.current = false;
                }}
              />
            </span>
          </TableCell>
        )}
        {model.shown.map((column) => (
          <DataCell
            key={column.id}
            ctx={ctx}
            row={row}
            id={column.id}
            opens={opens}
            status={status}
            detail={detail !== undefined}
          />
        ))}
        {props.rowActions !== undefined && (
          <TableCell align="end">
            <span data-row-actions={row.id} {...stylex.props(styles.inLine)}>
              <DropdownMenu>
                <span {...stylex.props(styles.inRow)}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={words.actionsFor(name)}
                    >
                      <Icon icon={EllipsisIcon} />
                    </Button>
                  </DropdownMenuTrigger>
                </span>
                <DropdownMenuContent align="end">
                  {props.rowActions(row.original).map((action) => (
                    <DropdownMenuItem
                      key={action.label}
                      onSelect={() => {
                        ctx.onRowAction(row.id, action);
                      }}
                    >
                      {action.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </TableCell>
        )}
      </TableRow>
      {detail !== undefined &&
        model.flags.expanding &&
        model.isOpen(row.id) && (
          <TableRow>
            <TableCell colSpan={model.span}>
              <div id={detailId(row.id)} {...stylex.props(styles.detail)}>
                {detail(row.original)}
              </div>
            </TableCell>
          </TableRow>
        )}
    </>
  );
};

/** Placeholders in the rows' place, each a row's height, so nothing moves when the rows come. */
const Placeholders = <Row extends RowData>({
  ctx: { model, props },
  count,
}: {
  ctx: Ctx<Row>;
  count: number;
}) =>
  Array.from({ length: count }, (_, index) => (
    <TableRow key={`waiting-${String(index)}`}>
      {props.selectable === true && (
        <TableCell pin={model.selectPin}>
          <span {...stylex.props(styles.pick)} />
        </TableCell>
      )}
      {model.shown.map((column, at) => {
        const meta = model.columnOf(column.id);
        return (
          <TableCell
            key={column.id}
            pin={model.pinOf(column.id)}
            align={meta?.align}
            hideBelow={meta?.hideBelow}
          >
            {meta?.skeleton === "person" ? (
              <span aria-hidden="true" {...stylex.props(styles.person)}>
                <span {...stylex.props(styles.personPicture)}>
                  <Skeleton variant="circular" />
                </span>
                <span {...stylex.props(styles.personLines)}>
                  <span {...stylex.props(styles.personLine, styles.personName)}>
                    <Skeleton />
                  </span>
                  <span
                    {...stylex.props(styles.personLine, styles.personDetail)}
                  >
                    <Skeleton />
                  </span>
                </span>
              </span>
            ) : (
              <span
                {...stylex.props(
                  styles.waiting,
                  at === 0 && styles.waitingLead,
                  meta?.align === "end" && styles.waitingEnd
                )}
              >
                <Skeleton />
              </span>
            )}
          </TableCell>
        );
      })}
      {props.rowActions !== undefined && <TableCell />}
    </TableRow>
  ));

// A row that speaks for the whole table, its words in what the box shows while the table scrolls.
const Across = <Row extends RowData>({
  ctx,
  children,
}: {
  ctx: Ctx<Row>;
  children: ReactNode;
}) => (
  <TableRow>
    <TableCell colSpan={ctx.model.span}>
      <div {...stylex.props(styles.across)}>{children}</div>
    </TableCell>
  </TableRow>
);

/** An Empty from what a page gave: its words, its picture, its way on. */
const Said = ({ state }: { state: DataTableEmptyState }) => (
  <Empty>
    <EmptyHeader>
      <EmptyMedia icon={state.icon} illustration={state.picture} />
      <EmptyTitle>{state.title}</EmptyTitle>
      <EmptyDescription>{state.description}</EmptyDescription>
    </EmptyHeader>
    <EmptyContent>{state.action}</EmptyContent>
  </Empty>
);

/** The rows did not load: Empty's words, then Try again under them. */
const Failed = <Row extends RowData>({
  ctx,
  error,
}: {
  ctx: Ctx<Row>;
  error: NonNullable<DataTableProps<Row>["error"]>;
}) => {
  const { words, unit } = ctx;
  const { onRetry } = error;
  return (
    <Across ctx={ctx}>
      <div {...stylex.props(styles.state)}>
        <Empty variant="destructive">
          <EmptyHeader>
            <EmptyMedia />
            <EmptyTitle>{error.title ?? words.error(unit.other)}</EmptyTitle>
            <EmptyDescription>
              {error.description ?? words.failedDetail}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
        {onRetry !== undefined && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onRetry();
            }}
          >
            {words.tryAgain}
          </Button>
        )}
      </div>
    </Across>
  );
};

/**
 * Nothing matches the search or the filter: the page's own words (`noResults`), told what was
 * asked, or one line. The rows stay, collapsed, so the columns keep their widths and the head does
 * not jump as the search is typed.
 */
const NoResults = <Row extends RowData>({ ctx }: { ctx: Ctx<Row> }) => {
  const { model, props, words, unit } = ctx;
  const { query, condition } = model.own;
  const { fieldId } = condition;
  const header = props.columns.find((column) => column.id === fieldId)?.header;
  const said =
    props.noResults === undefined ? (
      <span {...stylex.props(styles.muted)}>
        {query === ""
          ? words.noneMeet(unit.other)
          : words.noMatch(unit.other, query)}
      </span>
    ) : (
      <Said
        state={props.noResults({
          query,
          filter:
            model.filtered && fieldId !== null
              ? {
                  column: fieldId,
                  header: header ?? fieldId,
                  operator: condition.operatorId ?? "",
                  value: String(condition.value ?? ""),
                }
              : null,
          clear: () => {
            model.own.setQuery("");
            model.own.setCondition(noCondition);
          },
        })}
      />
    );
  return (
    <>
      <Across ctx={ctx}>{said}</Across>
      {model.table
        .getCoreRowModel()
        .rows.slice(0, props.pageSize ?? 20)
        .map((row) => (
          <DataRow key={row.id} ctx={ctx} row={row} kept />
        ))}
    </>
  );
};

/** Why there are no rows, in their place; or the rows, with placeholders after them while more come. */
const Body = <Row extends RowData>({ ctx }: { ctx: Ctx<Row> }) => {
  const { model, props, words, unit } = ctx;
  const { groupBy } = props;
  const { rows } = model.table.getRowModel();
  if (props.error !== undefined) {
    return <Failed ctx={ctx} error={props.error} />;
  }
  if (props.loading === true) {
    return <Placeholders ctx={ctx} count={props.pageSize ?? 5} />;
  }
  if (rows.length === 0 && model.own.query === "" && !model.filtered) {
    return (
      <Across ctx={ctx}>
        <Said
          state={props.emptyState ?? { description: words.noneYet(unit.other) }}
        />
      </Across>
    );
  }
  if (rows.length === 0) {
    return <NoResults ctx={ctx} />;
  }
  return (
    <>
      {rows.map((row) =>
        // A feature's API exists only while the table holds it: grouping's is asked only then.
        model.flags.grouping && groupBy !== undefined && row.getIsGrouped() ? (
          <GroupRow key={row.id} ctx={ctx} row={row} groupBy={groupBy} />
        ) : (
          <DataRow key={row.id} ctx={ctx} row={row} />
        )
      )}
      {props.loadingMore === true && <Placeholders ctx={ctx} count={3} />}
    </>
  );
};

/** The Alert dialog a grave action asks in before it is done to the selected rows. */
const Confirm = <Row extends RowData>({
  ctx: { model, words, unit },
  asking,
  onAnswer,
}: {
  ctx: Ctx<Row>;
  asking: DataTableAction | null;
  onAnswer: (yes: boolean) => void;
}) => {
  const count = model.own.selected.length;
  const question =
    typeof asking?.confirm === "function"
      ? asking.confirm(count)
      : asking?.confirm;
  return (
    <AlertDialog
      open={asking !== null}
      onOpenChange={(next, details) => {
        if (!next) {
          onAnswer(details.returnValue === "confirm");
        }
      }}
    >
      {asking !== null && (
        <AlertDialogContent>
          <AlertDialogTitle>
            {question?.title ??
              words.confirm(
                asking.label,
                count,
                count === 1 ? unit.one : unit.other
              )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {question?.description ?? words.confirmDetail}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{words.cancel}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" value="confirm">
              {asking.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
};

// ---- The table -----------------------------------------------------------------------------------

/** Says so, once, when the table toasts and the page has no Toaster to draw it. */
let warned = false;

/** What holds focus now, when it is an element that can take it back. */
const focused = () =>
  document.activeElement instanceof HTMLElement &&
  document.activeElement !== document.body
    ? document.activeElement
    : null;

/** A Table that sorts, searches, selects rows and pages through them. */
export const DataTable = <Row extends RowData>(props: DataTableProps<Row>) => {
  const { "aria-label": label, pageSize } = props;
  const { dataTable: words } = useI18n();
  // What a row is called: the table's own, else the I18nProvider's word for a row.
  const unit = props.unit ?? words.unit;
  const { model, holder } = useDataTable(props);
  // Focus never falls back to the page after an action. What held focus when an action was asked
  // or done takes it back once the change is drawn. A row's action gives it to its row's actions,
  // or, when the action took the row away, to the next row's (its target, if it opens), else the
  // one before. If that is gone too (the bar leaves when nothing is selected any more), the head's
  // checkbox takes it, the nearest control that is always there, else the table's own box.
  const back = useRef<HTMLElement | null>(null);
  const rowBack = useRef<{ id: string; ids: string[] } | null>(null);
  const settle = useRef(false);
  useEffect(() => {
    if (!settle.current) {
      return;
    }
    settle.current = false;
    const was = back.current;
    const from = rowBack.current;
    back.current = null;
    rowBack.current = null;
    const root = holder.current;
    const actionsOf = (id: string) =>
      root?.querySelector<HTMLElement>(
        `[data-row-actions="${CSS.escape(id)}"] button`
      );
    const at = from === null ? -1 : from.ids.indexOf(from.id);
    const beside = [
      ...(from?.ids.slice(at + 1) ?? none),
      ...(from?.ids.slice(0, Math.max(at, 0)).toReversed() ?? none),
    ]
      .map(actionsOf)
      .find((each) => each !== null && each !== undefined);
    const next =
      (was?.isConnected === true ? was : undefined) ??
      (from === null ? undefined : actionsOf(from.id)) ??
      beside?.closest("tr")?.querySelector<HTMLElement>("[data-row-target]") ??
      beside ??
      root?.querySelector<HTMLElement>("thead [role=checkbox]") ??
      root?.querySelector<HTMLElement>("[data-slot=table-container][tabindex]");
    next?.focus({ preventScroll: true });
  });
  const view: View<Row> = { model, props, words, unit };
  const ctx: Ctx<Row> = {
    ...view,
    onRowAction: (id, action) => {
      rowBack.current = {
        id,
        ids: model.table.getRowModel().rows.map((row) => row.id),
      };
      settle.current = true;
      action.onSelect();
    },
  };
  const [asking, setAsking] = useState<DataTableAction | null>(null);
  const { kept, arrived } = useLoading(holder, props.loading === true);
  useView(view);
  const endRef = useEnd(view);

  const fields = props.columns.flatMap((column) =>
    column.filter === false
      ? []
      : [fieldFor(column.id, column.header, column.filter ?? "text", words)]
  );
  // The table as the page's agent bridge knows it: named by its label, with actions of its own.
  const agentHandle = usePrimitive(dataTableAgent, {
    tools: toolsFor(view, fields),
  });

  // Does an action to the selected rows; an undoable one says so with Undo in a Toast.
  const handleAct = (action: DataTableAction) => {
    // Asked first (a grave action): what asked keeps its claim. Done at once: what was pressed.
    const asked = back.current;
    back.current = asked ?? focused();
    settle.current = true;
    const ids = [...model.own.selected];
    const undo = action.run(ids);
    model.table.resetRowSelection(true);
    const said = words.done(
      action.label,
      ids.length,
      ids.length === 1 ? unit.one : unit.other
    );
    if (
      !warned &&
      document.querySelector("[data-slot=toast-region]") === null
    ) {
      warned = true;
      console.warn(
        "DataTable: an action was done and no Toaster is on the page, so its toast (and its Undo) shows nowhere. Put one <Toaster /> at the page's root, outside every layer, or pass the table a `toaster` with its own."
      );
    }
    const toast = props.toaster ?? pageToast;
    toast(said, undo && { action: { label: words.undo, onAction: undo } });
  };
  // Export: the rows found, every page, in the columns shown.
  const handleExport = () => {
    const columns = model.shown
      .map((column) => model.columnOf(column.id))
      .filter((column) => column !== undefined);
    saveCsv(
      toCsv(
        columns.map((column) => column.header),
        model
          .found()
          .map((row) => columns.map((column) => textOf(column, row.original)))
      ),
      props.exportFileName ?? label
    );
  };

  const found =
    props.rowCount ?? model.table.getPrePaginatedRowModel().rows.length;
  const hasBar =
    props.searchable === true ||
    props.selectable === true ||
    props.filterable === true ||
    props.exportFileName !== undefined ||
    model.flags.hiding;
  let status = "";
  if (props.loading === true) {
    status = words.loading(unit.other);
  } else if (props.loadingMore === true) {
    status = words.loadingMore(unit.other);
  }

  // Named for scripts and styles that find it; given as a value, since a part's props name no data
  // attributes.
  const slot = { "data-slot": "data-table" };
  return usePart(
    agentHandle,
    "root",
    {},
    {
      ...slot,
      ref: holder,
      "aria-label": label,
      "aria-busy": props.loading === true ? true : undefined,
      ...stylex.props(styles.root, props.style),
      children: (
        <>
          <output {...stylex.props(visuallyHidden)}>{status}</output>
          {hasBar && (
            <Bar
              ctx={ctx}
              fields={fields}
              onAct={handleAct}
              onAsk={(action) => {
                back.current = focused();
                setAsking(action);
              }}
              onExport={handleExport}
            />
          )}
          <div
            {...stylex.props(
              styles.hold,
              kept !== null && styles.keeps(`${String(kept)}px`)
            )}
          >
            <Table
              caption={props.caption}
              aria-label={props.caption === undefined ? label : undefined}
              density={props.density}
              height={props.height}
              width={model.tableWidth}
              fade={!model.holds}
              bottomContent={<div ref={endRef} aria-hidden="true" />}
            >
              <TableHeader>
                <HeadRow ctx={ctx} />
              </TableHeader>
              <TableBody animateIn={arrived}>
                <Body ctx={ctx} />
              </TableBody>
            </Table>
          </div>
          {pageSize !== undefined && found > pageSize && (
            <Pagination
              total={found}
              pageSize={pageSize}
              page={model.pageNow}
              onPageChange={(next) => {
                model.table.setPageIndex(next - 1);
              }}
              aria-label={words.pages(label)}
              unit={unit}
            >
              <PaginationRange />
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious />
                </PaginationItem>
                <PaginationItem>
                  <PaginationNext />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
          <Confirm
            ctx={ctx}
            asking={asking}
            onAnswer={(yes) => {
              if (yes && asking !== null) {
                handleAct(asking);
              }
              // Cancelled: focus goes back to the button that asked.
              settle.current = true;
              setAsking(null);
            }}
          />
        </>
      ),
    }
  );
};

// ---- Dates ---------------------------------------------------------------------------------------
//
// A date column says when, as people do ("3 hours ago", "Yesterday", then the day), in the reader's
// language from the platform's Intl, the full date and time in a tooltip on hover and on focus, and
// the date itself in a <time datetime>. One clock ticks for every date on the page, once a minute;
// the words stand in a box as wide as the widest they can be, so the row never moves.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The start of a date's day, in the reader's own time zone. */
const dayOf = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

// Intl's formats are slow to make and every date cell asks for them on every tick: one of each per
// locale, made once, and the widest words once per locale too.
const once = <Made,>(
  made: Map<string, Made>,
  key: string,
  make: () => Made
): Made => {
  const known = made.get(key);
  if (known !== undefined) {
    return known;
  }
  const fresh = make();
  made.set(key, fresh);
  return fresh;
};
const relatives = new Map<string, Intl.RelativeTimeFormat>();
const dates = new Map<string, Intl.DateTimeFormat>();
const widest = new Map<string, number>();
const relativeIn = (locale: string | undefined) =>
  once(
    relatives,
    locale ?? "",
    () => new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  );
const dayIn = (locale: string | undefined, year: boolean) =>
  once(
    dates,
    `day ${locale ?? ""} ${String(year)}`,
    () =>
      new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "short",
        ...(year ? { year: "numeric" } : {}),
      })
  );
const fullIn = (locale: string | undefined) =>
  once(
    dates,
    `full ${locale ?? ""}`,
    () =>
      new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short" })
  );

/** The relative words and the full date and time, for a date seen at `now`. */
const when = (date: Date, now: number, locale?: string) => {
  const relative = relativeIn(locale);
  const gap = date.getTime() - now;
  const days = Math.round((dayOf(date) - dayOf(new Date(now))) / (24 * HOUR));
  let words: string;
  if (Math.abs(gap) < MINUTE) {
    words = relative.format(0, "second");
  } else if (Math.abs(gap) < HOUR) {
    words = relative.format(Math.trunc(gap / MINUTE), "minute");
  } else if (days === 0) {
    words = relative.format(Math.trunc(gap / HOUR), "hour");
  } else if (Math.abs(days) === 1) {
    words = relative.format(days, "day");
  } else {
    words = dayIn(
      locale,
      date.getFullYear() !== new Date(now).getFullYear()
    ).format(date);
  }
  // The first letter in capitals, as it starts a cell: "Yesterday", "Gisteren".
  return {
    words: words.charAt(0).toLocaleUpperCase(locale) + words.slice(1),
    full: fullIn(locale).format(date),
  };
};

/** The widest the words can be in a locale, in characters. */
const widestWords = (locale?: string) =>
  once(widest, locale ?? "", () => {
    const relative = relativeIn(locale);
    const day = dayIn(locale, true);
    let most = 0;
    for (const each of [
      relative.format(0, "second"),
      relative.format(-59, "minute"),
      relative.format(59, "minute"),
      relative.format(-23, "hour"),
      relative.format(23, "hour"),
      relative.format(-1, "day"),
      relative.format(1, "day"),
      ...Array.from({ length: 12 }, (_, month) =>
        day.format(new Date(2026, month, 28))
      ),
    ]) {
      most = Math.max(most, each.length);
    }
    return most;
  });

// The one clock: the minute now, shared by every reader, ticking while anyone listens. While no one
// does (on the server, before the first date subscribes) it is read afresh once it is a minute old,
// so a server's words never drift with the age of its process.
let minute = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (timer === undefined) {
    minute = Date.now();
    timer = setInterval(() => {
      minute = Date.now();
      for (const each of listeners) {
        each();
      }
    }, MINUTE);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
};
const readMinute = () => {
  if (timer === undefined && Math.abs(Date.now() - minute) >= MINUTE) {
    minute = Date.now();
  }
  return minute;
};

/** A date as a row gives it: a Date, an ISO string or a time in milliseconds; none, no date. */
export type DataTableDate = Date | string | number | null | undefined;

/** Everything a date column takes: a column's own props, and where its date is. */
export interface DataTableDateColumn<Row> extends Omit<
  DataTableColumn<Row>,
  "value" | "text" | "cell" | "filter"
> {
  /** The row's date. */
  date: (row: Row) => DataTableDate;
}

/** The date as a Date, or nothing when there is none or it does not read as one. */
const dateOf = (given: DataTableDate): Date | null => {
  const date = new Date(given ?? Number.NaN);
  return given === "" || Number.isNaN(date.getTime()) ? null : date;
};

/** A date cell: its words, the full date in a tooltip, or a quiet dash with none. */
export const DataTableDateCell = ({ date: given }: { date: DataTableDate }) => {
  const locale = useLocale();
  const now = useSyncExternalStore(subscribe, readMinute, readMinute);
  const { noDate } = useI18n().dataTable;
  const date = dateOf(given);
  if (date === null) {
    return (
      <span data-slot="data-table-date">
        <span aria-hidden="true" {...stylex.props(styles.muted)}>
          —
        </span>
        <span {...stylex.props(visuallyHidden)}>{noDate}</span>
      </span>
    );
  }
  const { words, full } = when(date, now, locale);
  return (
    <span {...stylex.props(styles.dateRoom(`${widestWords(locale)}ch`))}>
      <Tooltip>
        <TooltipTrigger asChild tabIndex={0}>
          {/* It takes focus, so the keys reach its tooltip as a pointer does. The server's words
              stay on the first paint; the first tick brings the reader's. */}
          <time
            dateTime={date.toISOString()}
            data-slot="data-table-date"
            suppressHydrationWarning
            {...stylex.props(styles.date, focusRingText)}
          >
            {words}
          </time>
        </TooltipTrigger>
        <TooltipContent>{full}</TooltipContent>
      </Tooltip>
    </span>
  );
};

/**
 * A Data table column of dates: sorted by the date (a missing one as the earliest), drawn as words,
 * searched and exported as the date.
 */
export const dateColumn = <Row,>({
  date,
  ...column
}: DataTableDateColumn<Row>): DataTableColumn<Row> => ({
  ...column,
  value: (row) => dateOf(date(row))?.getTime() ?? Number.NEGATIVE_INFINITY,
  // Searched and exported as the date itself (ISO 8601, which a spreadsheet reads), not its time in
  // milliseconds.
  text: (row) => dateOf(date(row))?.toISOString() ?? "",
  cell: (row) => <DataTableDateCell date={date(row)} />,
  filter: false,
});
