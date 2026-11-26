// DataGrid: a spreadsheet in the page. One active cell and a range; the arrows, Tab, Enter, Home,
// End and the page keys move, mod with an arrow jumps to the edge; typing, Enter, F2 or a double
// press edits in place; Space ticks a box; copy, cut and paste speak TSV with real spreadsheets;
// Delete clears; mod+Z undoes. The grid stores nothing: every edit leaves as a patch
// (`onCellsChange`) for you to apply to your rows (`applyDataGridPatch` does it for plain rows).
//
//   const [rows, setRows] = useState(tasks);
//   <DataGrid
//     aria-label="Launch plan"
//     rows={rows}
//     getRowId={(task) => task.id}
//     columns={[
//       { key: "task", header: "Task", type: "text", value: (task) => task.task, sortable: true },
//       { key: "budget", header: "Budget", type: "currency", value: (task) => task.budget },
//       { key: "done", header: "Done", type: "boolean", value: (task) => task.done },
//     ]}
//     onCellsChange={(patch) => setRows((now) => applyDataGridPatch(now, patch, (task) => task.id))}
//   />
//
// It is an ARIA grid on a real table: the active cell holds the one tab stop (a roving tabindex),
// the head row is one more stop, and a live region says ranges, edits, copies and pastes. Its
// looks (the active cell, a range, the head) are props: `appearance`. Every value is a token.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  ChangeEvent,
  ClipboardEvent,
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
} from "react";

import { useI18n, useLocale } from "../../lib/i18n";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CalendarIcon,
  CheckIcon,
  CircleUserIcon,
  DollarSignIcon,
  HashIcon,
  Icon,
  ListDashIcon,
  SquareCheckIcon,
  TextIcon,
} from "../../lib/icons";
import type { IconData } from "../../lib/icons";
import {
  choiceBoxStyles,
  focusRingInset,
  scrollbarHidden,
  tapTargetAfter,
  visuallyHidden,
} from "../../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "../../lib/tokens.stylex";
import { ownValue } from "../../lib/utils";
import type { LayoutStyle } from "../../lib/utils";
import { iconVars, motionVars, pixel, pixelVars } from "../../lib/vars.stylex";
import {
  all,
  at,
  cellsOf,
  clearedOf,
  contains,
  copiedOf,
  fit,
  fromTsv,
  isFigure,
  isRange,
  move,
  nextSort,
  pasteTarget,
  plainOf,
  rectOf,
  record,
  shownOf,
  sortRows,
  stepHistory,
  toTsv,
  valueFrom,
} from "./model";
import type {
  DataGridCell,
  DataGridCellValue,
  DataGridChange,
  DataGridColumn,
  DataGridColumnType,
  DataGridPatch,
  DataGridSelection,
  History,
  Rect,
  Sort,
} from "./model";

/** How the active cell is drawn: a soft halo (the default) or an underline. */
export type DataGridActiveAppearance = "halo" | "underline";
/** How a chosen range is drawn: a wash with a pine edge (the default), a firmer mint edge, or dither. */
export type DataGridRangeAppearance = "wash" | "outline" | "dither";
/** How the head is drawn: quiet on a soft ground (the default), lifted, or with type chips. */
export type DataGridHeaderAppearance = "quiet" | "lifted" | "chip";

/** How the grid is drawn. */
export interface DataGridAppearance {
  /** The active cell. @default "halo" */
  active?: DataGridActiveAppearance;
  /** A chosen range. @default "wash" */
  range?: DataGridRangeAppearance;
  /** The head row. @default "quiet" */
  header?: DataGridHeaderAppearance;
}

/** Every prop a DataGrid takes. `Row` is the shape of one row of your data. */
export interface DataGridProps<Row> {
  /** What the rows are, in a word or two ("Launch plan"): the grid's name. */
  "aria-label": string;
  /** The columns, in order. */
  columns: readonly DataGridColumn<Row>[];
  /** The rows of data. The grid stores none: apply each patch to them yourself. */
  rows: readonly Row[];
  /** A unique, lasting id for a row. */
  getRowId: (row: Row) => string;
  /**
   * Called with every edit, paste, clear, cut, undo and redo, as the cells it changes. Apply it to
   * your rows; without it the grid is read-only.
   */
  onCellsChange?: (patch: DataGridPatch) => void;
  /** How the active cell, a range and the head are drawn. */
  appearance?: DataGridAppearance;
  /** What is chosen at first: one cell, or a range. The first cell, unless given. */
  defaultSelection?: DataGridSelection;
  /**
   * What Tab does on a cell. "move" steps to the next cell as a spreadsheet does, Shift+Tab to the
   * one before, and it leaves after the last cell and before the first. "leave" makes the grid one
   * stop: Tab leaves at once and the arrows alone move inside. An open editor's Tab commits and
   * moves on either way. @default "move"
   */
  tabNavigation?: "move" | "leave";
  /** A column of row numbers at the start. @default true */
  showRowNumbers?: boolean;
  /** Columns can be made wider or narrower by the handle at a head's end. @default false */
  resizable?: boolean;
  /** The locale figures are written and read in. @default the I18nProvider's, else "en" */
  locale?: string;
  /** Layout only: margins and alignment. The look belongs to the grid. */
  style?: LayoutStyle;
}

const typeIcon: Record<DataGridColumnType, IconData> = {
  text: TextIcon,
  number: HashIcon,
  currency: DollarSignIcon,
  select: ListDashIcon,
  date: CalendarIcon,
  person: CircleUserIcon,
  boolean: SquareCheckIcon,
};
const sortIcon = { ascending: ArrowUpIcon, descending: ArrowDownIcon };

// ---- The look: the Table's type, room and hairlines, a step denser, drawn as a sheet ------------
//
// One line only between any two cells: each cell draws the hairline at its end and below it, the
// last column and last row keep theirs clear, and the frame's soft edge closes the grid.

const styles = stylex.create({
  frame: {
    position: "relative",
    isolation: "isolate",
    width: "100%",
    overflow: "hidden",
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: shadow.sm,
    outline: {
      default: "none",
      [media.forcedColors]: `${size.hairline} solid`,
    },
  },
  // It scrolls without a bar; the fades say there is more.
  scroller: {
    overflowX: "auto",
    overscrollBehaviorX: "contain",
  },
  // A cell brought into view stops clear of the row numbers, which stay put over the grid's start.
  scrollerNumbered: { scrollPaddingInlineStart: size.dataGridNumberWidth },
  grid: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    position: "relative",
    display: "grid",
    minWidth: "min-content",
    margin: 0,
    borderSpacing: 0,
    color: colors.bodyForeground,
    fontFamily: font.sans,
    fontSize: size.tableText,
    lineHeight: size.tableTextLine,
    fontVariantNumeric: "tabular-nums",
    textAlign: "start",
    userSelect: "none",
    WebkitUserSelect: "none",
    outline: "none",
  },
  // A column is never narrower than its header or its widest cell, until it is given a width.
  columns: (template: string) => ({ gridTemplateColumns: template }),
  group: { display: "contents" },
  row: {
    display: "grid",
    gridColumn: "1 / -1",
    gridTemplateColumns: "subgrid",
  },
  // ---- The head ----
  headRow: { position: "relative", zIndex: 3 },
  headRowQuiet: { backgroundColor: colors.muted },
  // As a head with rows scrolled under it: the low lift in place of the hairline.
  headRowLifted: { backgroundColor: colors.card, boxShadow: shadow.sm },
  headRowChip: { backgroundColor: colors.card },
  head: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    minWidth: 0,
    height: size.dataGridHeadHeight,
    padding: 0,
    boxSizing: "border-box",
    whiteSpace: "nowrap",
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    color: colors.mutedForeground,
    borderWidth: 0,
    borderBlockEndWidth: size.hairline,
    borderInlineEndWidth: size.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
  },
  headLifted: { borderBlockEndColor: "transparent" },
  // A head's name and its type's icon: plain, or a button that sorts.
  name: {
    display: "flex",
    alignItems: "center",
    gap: space[2],
    flexGrow: 1,
    minWidth: 0,
    height: "100%",
    boxSizing: "border-box",
    paddingInline: space.tableCellInline,
    color: "inherit",
    font: "inherit",
  },
  sorts: {
    appearance: "none",
    margin: 0,
    borderWidth: 0,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [media.hover]: colors.accent },
    },
    color: {
      default: "inherit",
      ":hover": { default: null, [media.hover]: colors.foreground },
    },
    cursor: "pointer",
    textAlign: "start",
    transitionProperty: "background-color, color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  // A head's ring stands a little further in than the shared inside ring, so its lower side never
  // lies on the active cell's edge just below it.
  sortsRing: {
    outlineOffset: {
      default: null,
      ":focus-visible": `calc(-1 * ${size.ringWidth} - ${space[1]})`,
    },
  },
  // On a touch screen the button takes a finger's reach (tapTargetAfter), a little taller than the
  // head it is drawn in, which keeps its height.
  sortsReach: { position: "relative" },
  sorted: { color: colors.foreground },
  nameEnd: { justifyContent: "flex-end" },
  nameCentre: { justifyContent: "center", paddingInline: space[2] },
  words: { overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 },
  markQuiet: { display: "flex", flexShrink: 0 },
  markLifted: {
    display: "flex",
    flexShrink: 0,
    color: colors.dataGridActiveBorder,
  },
  markChip: {
    display: "grid",
    flexShrink: 0,
    placeItems: "center",
    width: size.kbdHeight,
    height: size.kbdHeight,
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    backgroundColor: colors.dataGridRangeWash,
    color: colors.dataGridActiveBorder,
  },
  // The sort's arrow, in the type icon's place while the column is sorted: in ink, as its name is.
  sortMark: { color: colors.foreground },
  // The resize handle: a range input in a reach inside the head's end. Its line shows under a
  // pointer and while held.
  handle: {
    display: { default: null, [media.pointerCoarse]: "none" },
    appearance: "none",
    position: "absolute",
    insetBlock: 0,
    // The last column's handle stands a step in from the grid's rounded corner, so its ring is
    // whole.
    insetInlineEnd: { default: 0, ":is(th:last-child *)": space[1] },
    zIndex: 1,
    boxSizing: "border-box",
    width: space[2],
    height: "100%",
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderInlineEndWidth: size.lineStrong,
    borderStyle: "solid",
    borderColor: {
      default: "transparent",
      ":hover": { default: null, [media.hover]: colors.dataGridActiveBorder },
      ":active": colors.dataGridActiveBorder,
    },
    backgroundColor: "transparent",
    cursor: "col-resize",
    touchAction: "none",
    "::-webkit-slider-thumb": { appearance: "none", width: 0, height: 0 },
    "::-moz-range-thumb": {
      appearance: "none",
      width: 0,
      height: 0,
      borderWidth: 0,
    },
  },
  // ---- Cells ----
  cell: {
    position: "relative",
    // Scrolled into view, a cell stops clear of the fade at the edge (and of the row numbers at the
    // start), so the active cell's edge is never painted over.
    scrollMarginInlineStart: `calc(${size.dataGridNumberWidth} + ${space[6]})`,
    scrollMarginInlineEnd: space[6],
    display: "flex",
    alignItems: "center",
    gap: space[2],
    boxSizing: "border-box",
    minWidth: 0,
    height: size.dataGridRowHeight,
    paddingBlock: 0,
    paddingInline: space.tableCellInline,
    whiteSpace: "nowrap",
    fontWeight: "inherit",
    outline: "none",
    cursor: "cell",
    borderWidth: 0,
    borderBlockEndWidth: size.hairline,
    borderInlineEndWidth: size.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
  },
  // The last column and the last row leave the edge to the frame. The line keeps its room, so a
  // range's edge can still be drawn there and nothing moves.
  lastCol: { borderInlineEndColor: "transparent" },
  lastRow: { borderBlockEndColor: "transparent" },
  text: { overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 },
  // In the dither look the dots never run through the words: they stand on a pad of the range's
  // own ground, a little wider than them.
  textClear: {
    marginInline: `calc(-1 * ${space[1]})`,
    paddingInline: space[1],
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    backgroundImage: `linear-gradient(${colors.dataGridRangeWash}, ${colors.dataGridRangeWash})`,
  },
  // Kept in the cell while its editor is open, unseen, so the column keeps its width.
  unseenText: { visibility: "hidden" },
  // The row numbers stay put while the grid scrolls sideways.
  number: {
    position: "sticky",
    insetInlineStart: 0,
    zIndex: 2,
    justifyContent: "center",
    paddingInline: space[2],
    color: colors.mutedForeground,
    backgroundColor: colors.muted,
    cursor: "default",
  },
  numberHead: {
    position: "sticky",
    insetInlineStart: 0,
    zIndex: 2,
    backgroundColor: "inherit",
  },
  end: { justifyContent: "flex-end" },
  centre: { justifyContent: "center", paddingInline: space[2] },
  ink: { color: colors.foreground },
  readOnly: { cursor: "default" },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    height: size.badgeLabelHeightSm,
    paddingInline: space[2],
    borderRadius: radius.full,
    backgroundColor: colors.control,
    boxShadow: size.borderStrong,
    color: colors.foreground,
    // The table's own type, so its words sit on the row's line with their neighbours'.
    fontSize: size.tableText,
    lineHeight: size.tableTextLine,
  },
  // In a dithered range a chip stands on the raised ground under its own fill, so no dot shows
  // behind its words.
  chipClear: {
    backgroundColor: colors.card,
    backgroundImage: `linear-gradient(${colors.control}, ${colors.control})`,
  },
  // Checkbox's own box, at its own size, on the row's centre.
  box: {
    [iconVars.size]: size.checkboxMark,
    [iconVars.stroke]: size.checkboxMarkStroke,
    width: size.checkboxBox,
    height: size.checkboxBox,
    borderRadius: radius.sm,
    cornerShape: radius.shape,
  },
  boxCell: { cursor: "pointer" },
  // ---- The editor: the cell's own words, typed in place ----
  editor: {
    appearance: "none",
    position: "absolute",
    inset: 0,
    boxSizing: "border-box",
    width: "100%",
    height: "100%",
    margin: 0,
    paddingBlock: 0,
    paddingInline: space.tableCellInline,
    borderWidth: 0,
    outline: "none",
    backgroundColor: "transparent",
    color: colors.foreground,
    font: "inherit",
    fontVariantNumeric: "tabular-nums",
    cursor: "text",
  },
  editorEnd: { textAlign: "end" },
  editing: { backgroundColor: colors.card, cursor: "text" },
  wrong: {
    boxShadow: `inset 0 0 0 ${size.lineStrong} ${colors.inputBorderInvalid}, 0 0 0 3px ${colors.ringHaloInvalid}`,
  },
  // ---- A chosen range: the wash, quiet mint lines inside, and its edge on the hairlines ----
  inRange: {
    backgroundColor: {
      default: colors.dataGridRangeWash,
      [media.forcedColors]: "Highlight",
    },
    // The words in ink: on the wash a cell's own text colour read fainter than outside the range.
    color: {
      default: colors.foreground,
      [media.forcedColors]: "HighlightText",
    },
    borderColor: colors.dataGridRangeLine,
  },
  // The dither over the wash: lib's one pixel, a 2px square in every space-1.
  inRangeDither: {
    [pixelVars.color]: colors.dataGridRangeDot,
    backgroundImage: pixel.fill,
    backgroundSize: `${space[1]} ${space[1]}`,
    // In the middle of its tile, as the dot it is drawn for.
    backgroundPosition: "1px 1px",
  },
  edgeEndPine: {
    borderInlineEndColor: {
      default: colors.dataGridActiveBorder,
      [media.forcedColors]: "Highlight",
    },
  },
  edgeBelowPine: {
    borderBlockEndColor: {
      default: colors.dataGridActiveBorder,
      [media.forcedColors]: "Highlight",
    },
  },
  edgeEndMint: {
    borderInlineEndColor: {
      default: colors.dataGridRangeRing,
      [media.forcedColors]: "Highlight",
    },
  },
  edgeBelowMint: {
    borderBlockEndColor: {
      default: colors.dataGridRangeRing,
      [media.forcedColors]: "Highlight",
    },
  },
  // The firmer edge: a second hairline just inside the range, on the sides of its outer cells,
  // over the cell's own lines at its end and below so a row's line never notches it.
  firm: {
    "::after": {
      content: '""',
      position: "absolute",
      insetBlockStart: 0,
      insetInlineStart: 0,
      insetBlockEnd: `calc(-1 * ${size.hairline})`,
      insetInlineEnd: `calc(-1 * ${size.hairline})`,
      zIndex: 1,
      borderWidth: 0,
      borderStyle: "solid",
      borderColor: colors.dataGridRangeRing,
      pointerEvents: "none",
    },
  },
  firmTop: { "::after": { borderBlockStartWidth: size.hairline } },
  firmBottom: { "::after": { borderBlockEndWidth: size.hairline } },
  firmStart: { "::after": { borderInlineStartWidth: size.hairline } },
  firmEnd: { "::after": { borderInlineEndWidth: size.hairline } },
  // ---- The active cell, three ways ----
  activeBase: {
    zIndex: 1,
    outline: {
      default: "none",
      [media.forcedColors]: `${size.lineStrong} solid Highlight`,
    },
    outlineOffset: `calc(-1 * ${size.ringWidth})`,
  },
  // The hairlines round the cell turn pine with a second hairline just inside them, and when focus
  // comes into the grid a mint halo comes up round it, so entering the grid is seen.
  activeHalo: {
    boxShadow: {
      default: `inset 0 0 0 ${size.hairline} ${colors.dataGridActiveBorder}`,
      ":focus": `inset 0 0 0 ${size.hairline} ${colors.dataGridActiveBorder}, 0 0 10px 1px ${colors.dataGridActiveHalo}, 0 2px 6px ${colors.dataGridActiveHalo}`,
    },
  },
  // Alone, the active cell stands on the raised ground. In a range it keeps the range's wash.
  activeAlone: { backgroundColor: colors.card, backgroundImage: "none" },
  // Calmest: a mint wash and a pine line under the words; reached by the keyboard, a line all round
  // (and the cell's own line below let go, so the ring is as heavy at its foot as at its sides).
  activeUnderline: {
    backgroundColor: colors.dataGridRangeWash,
    borderBlockEndColor: { default: null, ":focus-visible": "transparent" },
    boxShadow: {
      default: `inset 0 calc(-1 * ${size.hairline}) 0 ${colors.dataGridActiveBorder}`,
      ":focus-visible": `inset 0 0 0 ${size.lineStrong} ${colors.dataGridActiveBorder}`,
    },
  },
  // In a range the underline's cell needs more than the wash its neighbours share: a line all round.
  activeUnderlineInRange: {
    boxShadow: `inset 0 0 0 ${size.lineStrong} ${colors.dataGridActiveBorder}`,
  },
  // ---- What scrolls under the edges ----
  fade: {
    position: "absolute",
    insetBlock: 0,
    zIndex: 4,
    width: space[6],
    pointerEvents: "none",
    opacity: 0,
    transitionProperty: "opacity",
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
  },
  fadeShown: { opacity: 1 },
  fadeEnd: { insetInlineEnd: 0 },
  fadeStart: { insetInlineStart: 0 },
  fadeStartNumbered: { insetInlineStart: size.dataGridNumberWidth },
  fadeToRight: {
    backgroundImage: `linear-gradient(to right, transparent, ${colors.card})`,
  },
  fadeToLeft: {
    backgroundImage: `linear-gradient(to left, transparent, ${colors.card})`,
  },
});

// ---- How a range and the active cell are drawn on the sheet's own hairlines ---------------------
//
// One line only between two cells: each cell draws the hairline at its end and below it. A range's
// edge is those same hairlines in another colour, so the cell before the range and the row above it
// carry its start and its top: the head row is row -1, the row numbers are column -1.

interface Drawn {
  rect: Rect;
  cell: DataGridCell;
  ranged: boolean;
  active: DataGridActiveAppearance;
  range: DataGridRangeAppearance;
  /** Focus is in the grid: only then is the active cell drawn (the grid keeps it either way). */
  focused: boolean;
}

interface Lines {
  end: boolean;
  below: boolean;
}

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

/** The lines of the cell at a row and column that carry an edge. */
const linesAt = (drawn: Drawn, row: number, col: number): Lines => {
  const { cell, active, focused } = drawn;
  const own = around(
    { top: cell.row, bottom: cell.row, left: cell.col, right: cell.col },
    row,
    col
  );
  if (!drawn.ranged) {
    // With no focus in the grid the cell draws no edge: a grid nobody is in is calm. Underlined,
    // the line below it alone; with the halo, the four round it.
    if (!focused) {
      return { end: false, below: false };
    }
    return active === "underline"
      ? { end: false, below: own.below && row === cell.row }
      : own;
  }
  const range = around(drawn.rect, row, col);
  // In a range the halo's cell keeps its own four lines, beside the range's edge.
  return active === "halo" && focused
    ? { end: range.end || own.end, below: range.below || own.below }
    : range;
};

// ---- The grid's state and what a person does to it ----------------------------------------------

/**
 * A cell by its row's id and its column's key, so it follows its row as rows come, go and sort; and
 * where it stood, for when its row has gone.
 */
interface Spot {
  id: string;
  key: string;
  at: DataGridCell;
}

/** The selection by spots: what a person chose stays chosen while the rows change. */
interface Chosen {
  active: Spot;
  anchor: Spot;
}

/** The open editor: its cell, and the words typed so far. */
interface Editing {
  /** Its cell, by row id and column key: an edit lands on the row it was opened on. */
  id: string;
  key: string;
  text: string;
  /** It opened on the cell's own words, all selected; a typed letter opens it on that letter. */
  all: boolean;
  /** Its words did not fit the column when Enter was pressed. */
  wrong: boolean;
}

const modOf = (event: KeyboardEvent) => event.metaKey || event.ctrlKey;
type Command = "all" | "undo" | "redo" | "tick" | "collapse" | "clear" | "edit";

// The keys that are not moves, by what they do.
const commandOf = (
  event: KeyboardEvent,
  ranged: boolean,
  onBox: boolean,
  canEdit: boolean
): Command | null => {
  const mod = modOf(event);
  const key = event.key.toLowerCase();
  if (mod && key === "a") {
    return "all";
  }
  if (mod && key === "z") {
    return event.shiftKey ? "redo" : "undo";
  }
  if (mod && key === "y") {
    return "redo";
  }
  if (key === " " && onBox) {
    return "tick";
  }
  if (key === "escape" && ranged) {
    return "collapse";
  }
  if (key === "delete" || key === "backspace") {
    return "clear";
  }
  return (key === "f2" || (key === "enter" && !event.shiftKey)) &&
    canEdit &&
    !mod
    ? "edit"
    : null;
};
const rtlOf = (element: Element | null) =>
  element !== null && getComputedStyle(element).direction === "rtl";
interface Edges {
  start: boolean;
  end: boolean;
  rtl: boolean;
}
/** Whether the grid runs on under each side of its frame; the edges as they were when unchanged. */
const edgesOf = (element: HTMLElement) => (now: Edges) => {
  const along = Math.abs(element.scrollLeft);
  const next = {
    start: along > 1,
    end: element.scrollWidth - element.clientWidth - along > 1,
    rtl: rtlOf(element),
  };
  return now.start === next.start &&
    now.end === next.end &&
    now.rtl === next.rtl
    ? now
    : next;
};
const cellIn = (grid: HTMLElement | null, { row, col }: DataGridCell) =>
  grid?.querySelector<HTMLElement>(
    `[data-row="${String(row)}"][data-col="${String(col)}"]`
  ) ?? null;
/** A head takes focus on its control (the button that sorts), or on itself when it has none. */
const headIn = (grid: HTMLElement | null, col: number) => {
  const head = grid?.querySelector<HTMLElement>(
    `thead th[data-head="${String(col)}"]`
  );
  return head?.querySelector<HTMLElement>("button") ?? head;
};
const templateFor = <Row,>(
  columns: readonly DataGridColumn<Row>[],
  widths: Record<string, number>,
  showRowNumbers: boolean
) =>
  [
    ...(showRowNumbers ? [size.dataGridNumberWidth] : []),
    ...columns.map((column) => {
      // A column's key can be a word from the data (a sheet's header): only a width set for it.
      const width = ownValue(widths, column.key);
      return width === undefined
        ? `minmax(max-content, ${String(column.flex ?? 1)}fr)`
        : `${String(Math.round(width))}px`;
    }),
  ].join(" ");

const useDataGrid = <Row,>(props: DataGridProps<Row>) => {
  const { columns, getRowId, onCellsChange } = props;
  const words = useI18n().dataGrid;
  const pageLocale = useLocale();
  const locale = props.locale ?? pageLocale ?? "en";
  const showRowNumbers = props.showRowNumbers !== false;
  const [sort, setSort] = useState<Sort | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [chosen, setChosen] = useState<Chosen>(() => {
    const first = props.defaultSelection ?? at({ row: 0, col: 0 });
    const spot = (cell: DataGridCell): Spot => {
      const row = props.rows[cell.row];
      return {
        id: row === undefined ? "" : getRowId(row),
        key: columns[cell.col]?.key ?? "",
        at: cell,
      };
    };
    return { active: spot(first.active), anchor: spot(first.anchor) };
  });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [past, setPast] = useState<History>({ done: [], undone: [] });
  const [said, setSaid] = useState("");
  const [focused, setFocused] = useState(false);
  const [edges, setEdges] = useState<Edges>({
    start: false,
    end: false,
    rtl: false,
  });
  const gridRef = useRef<HTMLTableElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // Set while the grid itself moves focus out of the editor, so its blur does not settle it twice.
  const leaving = useRef(false);
  // What held focus in the grid last, while focus is in it: when its row goes, focus comes back.
  const held = useRef<Element | null>(null);

  const shown = sortRows(props.rows, columns, sort).map((data) => ({
    id: getRowId(data),
    data,
  }));
  const extent = { rows: shown.length, cols: columns.length };
  const rowOf = (id: string) => shown.findIndex((line) => line.id === id);
  const colOf = (key: string) =>
    columns.findIndex((column) => column.key === key);
  // A spot where its row and column stand now; where it stood, if they have gone.
  const placeOf = ({ id, key, at: was }: Spot): DataGridCell => {
    const [row, col] = [rowOf(id), colOf(key)];
    return { row: row === -1 ? was.row : row, col: col === -1 ? was.col : col };
  };
  const spotAt = (cell: DataGridCell): Spot => ({
    id: shown[cell.row]?.id ?? "",
    key: columns[cell.col]?.key ?? "",
    at: cell,
  });
  // Rows can go while a cell among them is chosen: the selection stays inside the grid.
  const selection = fit(
    { active: placeOf(chosen.active), anchor: placeOf(chosen.anchor) },
    extent
  );
  const { active } = selection;
  const rect = rectOf(selection);
  const ranged = isRange(selection);
  const look = props.appearance;
  const drawn: Drawn = {
    rect,
    cell: active,
    ranged,
    active: look?.active ?? "halo",
    range: look?.range ?? "wash",
    focused,
  };

  const valueAt = ({ row, col }: DataGridCell) => {
    const line = shown[row];
    return line === undefined ? undefined : columns[col]?.value(line.data);
  };
  const editable = (col: number) =>
    onCellsChange !== undefined &&
    columns[col] !== undefined &&
    columns[col].readOnly !== true;
  const canEdit =
    editable(active.col) && columns[active.col]?.type !== "boolean";
  // The editor closes when its row or its column goes.
  const editAt =
    editing === null
      ? null
      : { row: rowOf(editing.id), col: colOf(editing.key) };
  const open = editAt !== null && editAt.row !== -1 && editAt.col !== -1;
  if (editing !== null && !open) {
    setEditing(null);
  }

  const changeAt = (
    cell: DataGridCell,
    to: DataGridCellValue | undefined
  ): DataGridChange | null => {
    const column = columns[cell.col];
    const line = shown[cell.row];
    const from = valueAt(cell);
    if (
      column === undefined ||
      line === undefined ||
      from === undefined ||
      to === undefined ||
      !editable(cell.col)
    ) {
      return null;
    }
    return { rowId: line.id, columnId: column.key, from, to };
  };

  /** An edit leaves as a patch and can be undone; changes that change nothing are dropped. */
  const commit = (
    kind: DataGridPatch["kind"],
    changes: (DataGridChange | null)[],
    message: string
  ) => {
    const real = changes.filter(
      (change): change is DataGridChange =>
        change !== null && change.from !== change.to
    );
    if (real.length === 0 || onCellsChange === undefined) {
      return;
    }
    const patch = { kind, changes: real };
    onCellsChange(patch);
    setPast((state) => record(state, patch));
    setSaid(message);
  };

  const choose = (next: DataGridSelection) => {
    setChosen({ active: spotAt(next.active), anchor: spotAt(next.anchor) });
    if (!isRange(next)) {
      setSaid("");
      return;
    }
    const box = rectOf(next);
    setSaid(
      words.selected(
        (box.bottom - box.top + 1) * (box.right - box.left + 1),
        columns[box.left]?.header ?? "",
        columns[box.right]?.header ?? "",
        box.top + 1,
        box.bottom + 1
      )
    );
  };

  const tick = (cell: DataGridCell) => {
    const column = columns[cell.col];
    if (column?.type !== "boolean") {
      return;
    }
    const next = valueAt(cell) !== true;
    commit(
      "edit",
      [changeAt(cell, next)],
      `${words.cell(column.header, cell.row + 1)}: ${next ? words.ticked : words.unticked}`
    );
  };

  const clear = (kind: "clear" | "cut") => {
    commit(
      kind,
      cellsOf(rect).map((cell) =>
        changeAt(cell, clearedOf(columns[cell.col]?.type ?? "text"))
      ),
      kind === "cut" ? words.cut : words.cleared
    );
  };

  const step = (back: boolean) => {
    const done = stepHistory(past, back);
    if (done === null || onCellsChange === undefined) {
      return;
    }
    onCellsChange(done.patch);
    setPast(done.state);
    setSaid(back ? words.undone : words.redone);
  };

  /** Opens the editor on the active cell: on its own words, or on a typed letter. */
  const startEdit = (typed?: string) => {
    if (!canEdit) {
      return;
    }
    const { id, key } = spotAt(active);
    setEditing({
      id,
      key,
      text: typed ?? plainOf(valueAt(active) ?? null, locale),
      all: typed === undefined,
      wrong: false,
    });
  };

  /**
   * Commits the editor's words and says whether it may close: words that do not fit the column
   * keep it open, marked wrong, unless `quietly` (focus has left: the cell keeps what it held).
   */
  const settle = (quietly: boolean): boolean => {
    if (editing === null || editAt === null || !open) {
      return true;
    }
    const column = columns[editAt.col];
    if (column === undefined) {
      return true;
    }
    const value = valueFrom(column, editing.text, locale);
    if (value === undefined && !quietly) {
      setEditing({ ...editing, wrong: true });
      setSaid(
        words.invalid(
          column.header,
          column.type === "select" ? words.takes.option : words.takes.figure
        )
      );
      return false;
    }
    commit("edit", [changeAt(editAt, value)], "");
    setEditing(null);
    return true;
  };

  // A drag ends wherever the pointer is let go.
  useEffect(() => {
    const stop = () => {
      dragging.current = false;
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  // Focus follows the active cell while the grid has it; focus already in that cell (its editor)
  // stays.
  useEffect(() => {
    const grid = gridRef.current;
    const cell = cellIn(grid, { row: active.row, col: active.col });
    if (
      grid?.contains(document.activeElement) === true &&
      cell !== null &&
      !cell.contains(document.activeElement)
    ) {
      cell.focus({ preventScroll: true });
      cell.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [active.row, active.col]);

  // The row that held focus has gone (a refetch took it), and focus with it: it comes back to the
  // active cell, so it never falls to the page.
  useLayoutEffect(() => {
    const was = held.current;
    if (
      was !== null &&
      !was.isConnected &&
      (document.activeElement === null ||
        document.activeElement === document.body)
    ) {
      cellIn(gridRef.current, active)?.focus({ preventScroll: true });
    }
  });

  // Whether the grid runs on under each side of its frame: the fades at the edges show by it. A
  // scroll that changes none of them draws no cell again.
  const readEdges = () => {
    if (scrollerRef.current !== null) {
      setEdges(edgesOf(scrollerRef.current));
    }
  };
  useEffect(() => {
    const element = scrollerRef.current;
    const watch = new ResizeObserver(() => {
      if (element !== null) {
        setEdges(edgesOf(element));
      }
    });
    // The grid inside it changes width too, as columns are resized.
    for (const each of [element, element?.firstElementChild]) {
      if (each !== null && each !== undefined) {
        watch.observe(each);
      }
    }
    return () => {
      watch.disconnect();
    };
  }, []);

  const moveBy = (event: KeyboardEvent) =>
    move(selection, extent, {
      key: event.key,
      shift: event.shiftKey,
      mod: modOf(event),
      rtl: rtlOf(gridRef.current),
    });

  /** Focus back on the active cell, out of its editor, without the editor's blur settling it. */
  const leaveEditor = () => {
    leaving.current = true;
    cellIn(gridRef.current, active)?.focus({ preventScroll: true });
    leaving.current = false;
  };

  // While the editor is open the keys are its own, but for three: Enter and Tab commit and move
  // on, Escape gives the cell back what it held.
  const editKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      leaveEditor();
      setEditing(null);
      return;
    }
    if (event.key !== "Enter" && event.key !== "Tab") {
      return;
    }
    event.preventDefault();
    if (!settle(false)) {
      return;
    }
    leaveEditor();
    const next = moveBy(event);
    if (next !== null) {
      choose(at(next.active));
    }
  };

  // On a head: Down goes into its column's first cell, and the arrows along the row go from head
  // to head. Every other key is the head's own control's (its sort; its handle keeps all its keys).
  const headKey = (event: KeyboardEvent) => {
    const head =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("th[data-head]")
        : null;
    if (head === null || event.target instanceof HTMLInputElement) {
      return;
    }
    const col = Number(head.dataset.head);
    if (event.key === "ArrowDown" && extent.rows > 0) {
      event.preventDefault();
      choose(at({ row: 0, col }));
      cellIn(gridRef.current, { row: 0, col })?.focus({ preventScroll: true });
      return;
    }
    const arrows: Partial<Record<string, number>> = {
      ArrowRight: 1,
      ArrowLeft: -1,
    };
    const along = (arrows[event.key] ?? 0) * (rtlOf(gridRef.current) ? -1 : 1);
    if (along !== 0 && col + along >= 0 && col + along < extent.cols) {
      event.preventDefault();
      headIn(gridRef.current, col + along)?.focus({ preventScroll: true });
    }
  };

  const commands: Record<Command, () => void> = {
    all: () => {
      choose(all(extent));
    },
    undo: () => {
      step(true);
    },
    redo: () => {
      step(false);
    },
    tick: () => {
      tick(active);
    },
    collapse: () => {
      choose(at(active));
    },
    clear: () => {
      clear("clear");
    },
    edit: () => {
      startEdit();
    },
  };

  // The keys that move, from a cell.
  const cellKey = (event: KeyboardEvent) => {
    // Up from the first row goes to the column's head, as Down from a head comes back.
    if (
      event.key === "ArrowUp" &&
      active.row === 0 &&
      !event.shiftKey &&
      !modOf(event)
    ) {
      event.preventDefault();
      headIn(gridRef.current, active.col)?.focus({ preventScroll: true });
      return;
    }
    const next = moveBy(event);
    // Tab leaves the grid past the last cell and before the first; at once where the grid is one
    // stop (`tabNavigation="leave"`). Only an open editor's Tab always commits and moves on.
    const stuck =
      next !== null &&
      next.active.row === active.row &&
      next.active.col === active.col;
    if (
      next === null ||
      (event.key === "Tab" && (stuck || props.tabNavigation === "leave"))
    ) {
      return;
    }
    event.preventDefault();
    choose(next);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    if (event.target instanceof Element && event.target.closest("thead")) {
      headKey(event);
      return;
    }
    if (editing !== null) {
      editKey(event);
      return;
    }
    const onBox = columns[active.col]?.type === "boolean" && !ranged;
    const command = commandOf(event, ranged, onBox, canEdit);
    if (command !== null) {
      event.preventDefault();
      commands[command]();
      return;
    }
    // A key that types a letter opens the editor on that letter.
    if (event.key.length === 1 && !modOf(event) && !event.altKey && canEdit) {
      event.preventDefault();
      startEdit(event.key);
      return;
    }
    cellKey(event);
  };

  // ---- Copy, cut and paste, as TSV, to and from real spreadsheets ----
  const copy = (event: ClipboardEvent) => {
    const block = Array.from({ length: rect.bottom - rect.top + 1 }, (_, row) =>
      Array.from({ length: rect.right - rect.left + 1 }, (__, col) =>
        copiedOf(
          valueAt({ row: rect.top + row, col: rect.left + col }) ?? null,
          locale
        )
      )
    );
    event.clipboardData.setData("text/plain", toTsv(block));
    event.preventDefault();
  };
  const handleCopy = (event: ClipboardEvent<HTMLTableElement>) => {
    if (editing === null) {
      copy(event);
      setSaid(words.copied);
    }
  };
  const handleCut = (event: ClipboardEvent<HTMLTableElement>) => {
    if (editing === null) {
      copy(event);
      clear("cut");
    }
  };
  const handlePaste = (event: ClipboardEvent<HTMLTableElement>) => {
    const text = event.clipboardData.getData("text/plain");
    if (editing !== null || text === "") {
      return;
    }
    event.preventDefault();
    // A read-only grid takes nothing: no range is chosen, and it says why.
    if (onCellsChange === undefined) {
      setSaid(words.readOnly);
      return;
    }
    const target = pasteTarget(fromTsv(text), selection, extent);
    commit(
      "paste",
      cellsOf(target.rect).map((cell) => {
        const column = columns[cell.col];
        return column === undefined
          ? null
          : changeAt(
              cell,
              valueFrom(column, target.value(cell.row, cell.col), locale)
            );
      }),
      words.pasted
    );
    choose({
      anchor: { row: target.rect.top, col: target.rect.left },
      active: { row: target.rect.bottom, col: target.rect.right },
    });
  };

  // ---- The pointer: press to choose, drag or Shift to grow, twice to edit ----
  const handlePress = (
    event: PointerEvent<HTMLTableCellElement>,
    cell: DataGridCell
  ) => {
    const onEditor = editAt?.row === cell.row && editAt.col === cell.col;
    const onActive = cell.row === active.row && cell.col === active.col;
    // A press in the open editor is the editor's own.
    if (event.button !== 0 || onEditor) {
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      choose({ anchor: selection.anchor, active: cell });
      return;
    }
    // A finger cannot press twice quickly with ease: a tap on the active cell opens it.
    if (event.pointerType === "touch" && onActive && !ranged) {
      startEdit();
      return;
    }
    dragging.current = event.pointerType !== "touch";
    choose(at(cell));
  };
  const handleRowPress = (
    event: PointerEvent<HTMLTableCellElement>,
    row: number
  ) => {
    if (event.button !== 0 || extent.cols === 0) {
      return;
    }
    const last = { row, col: extent.cols - 1 };
    choose({
      anchor: { row: event.shiftKey ? selection.anchor.row : row, col: 0 },
      active: last,
    });
    cellIn(gridRef.current, last)?.focus({ preventScroll: true });
  };

  return {
    gridRef,
    scrollerRef,
    readEdges,
    grid: {
      words,
      locale,
      columns,
      showRowNumbers,
      shown,
      selection,
      drawn,
      header: look?.header ?? "quiet",
      editing,
      editAt,
      said,
      edges,
      widths,
      template: templateFor(columns, widths, showRowNumbers),
      readOnly: onCellsChange === undefined,
      editable,
      sortOf: (key: string) => (sort?.key === key ? sort.direction : undefined),
      sort: (key: string) => {
        setSort(nextSort(sort, key));
      },
      resize: (key: string, width: number) => {
        setWidths({ ...widths, [key]: width });
      },
      autoFit: (key: string) => {
        setWidths(
          Object.fromEntries(
            Object.entries(widths).filter(([each]) => each !== key)
          )
        );
      },
      tick,
      startEdit,
      handleType: (text: string) => {
        setEditing((now) =>
          now === null ? now : { ...now, text, wrong: false }
        );
      },
      handleKeyDown,
      handleCopy,
      handleCut,
      handlePaste,
      handlePress,
      handleRowPress,
      handleEnter: (cell: DataGridCell) => {
        if (dragging.current) {
          setChosen((now) => ({ anchor: now.anchor, active: spotAt(cell) }));
        }
      },
      // Focus has left the editor by itself (a press elsewhere): it settles with what fits.
      handleEditorBlur: () => {
        if (!leaving.current) {
          settle(true);
        }
      },
      handleFocus: (event: FocusEvent<HTMLDivElement>) => {
        held.current = event.target;
        setFocused(true);
      },
      handleBlur: (event: FocusEvent<HTMLDivElement>) => {
        if (
          !(
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          )
        ) {
          setFocused(false);
          // Focus went somewhere of its own: kept only when what held it was taken out of the page.
          if (event.target.isConnected) {
            held.current = null;
          }
        }
      },
    },
  };
};

type Grid<Row> = ReturnType<typeof useDataGrid<Row>>["grid"];

// ---- The head row ------------------------------------------------------------------------------

const headRowStyle = {
  quiet: "headRowQuiet",
  lifted: "headRowLifted",
  chip: "headRowChip",
} as const;
const markStyle = {
  quiet: "markQuiet",
  lifted: "markLifted",
  chip: "markChip",
} as const;

/** The edge's colour on a cell's lines: pine, or mint for the firmer range. */
const edgeStyles = (lines: Lines, mint: boolean) => [
  lines.end && (mint ? styles.edgeEndMint : styles.edgeEndPine),
  lines.below && (mint ? styles.edgeBelowMint : styles.edgeBelowPine),
];

// A token's length in pixels, read from the page.
const lengthOf = (element: Element, name: string, fallback: number) => {
  const value = Number(
    getComputedStyle(element).getPropertyValue(name).replace("px", "")
  );
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const leastOf = (handle: Element) =>
  lengthOf(handle, "--damsko-table-column-min", 64);
const widthOf = (handle: Element) =>
  Math.round(handle.closest("th")?.getBoundingClientRect().width ?? 0);

interface HandleProps {
  label: string;
  width: number | undefined;
  onResize: (width: number) => void;
  onAutoFit: () => void;
}

// A range input, so a screen reader and the keys know it: dragged, it follows the pointer; with
// the arrow keys it moves a step from the column's measured width; pressed twice, the column fits
// its words again.
const Handle = ({ label, width, onResize, onAutoFit }: HandleProps) => {
  const drag = useRef<{ x: number; width: number; rtl: boolean } | null>(null);
  const handleDown = (event: PointerEvent<HTMLInputElement>) => {
    // The pointer resizes by how far it has gone, not as a range would slide.
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    drag.current = {
      x: event.clientX,
      width: widthOf(handle),
      rtl: rtlOf(handle),
    };
  };
  const handleMove = (event: PointerEvent<HTMLInputElement>) => {
    const from = drag.current;
    if (from !== null) {
      const gone = (event.clientX - from.x) * (from.rtl ? -1 : 1);
      onResize(Math.max(leastOf(event.currentTarget), from.width + gone));
    }
  };
  const handleUp = () => {
    drag.current = null;
  };
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onResize(
      Math.max(leastOf(event.currentTarget), Number(event.currentTarget.value))
    );
  };
  // Toward the column's end widens it, in either reading direction.
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const handle = event.currentTarget;
    const rtl = rtlOf(handle);
    const steps: Partial<Record<string, number>> = {
      ArrowRight: rtl ? -1 : 1,
      ArrowLeft: rtl ? 1 : -1,
      ArrowUp: 1,
      ArrowDown: -1,
    };
    const by = steps[event.key];
    if (by === undefined) {
      return;
    }
    event.preventDefault();
    const step = lengthOf(handle, "--damsko-table-resize-step", 16);
    onResize(Math.max(leastOf(handle), widthOf(handle) + by * step));
  };
  return (
    <input
      type="range"
      aria-label={label}
      min={64}
      max={Math.max(1200, width ?? 0)}
      step={16}
      value={width ?? 64}
      onChange={handleChange}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      onDoubleClick={onAutoFit}
      onKeyDown={handleKeyDown}
      {...stylex.props(styles.handle, focusRingInset)}
    />
  );
};

interface HeadNameProps<Row> {
  column: DataGridColumn<Row>;
  header: DataGridHeaderAppearance;
  sort: "ascending" | "descending" | undefined;
  /** The head row's one tab stop; the arrows reach the others. */
  stop: boolean;
  onSort: (event: MouseEvent<HTMLButtonElement>) => void;
}

// A box's column is as narrow as its box: its head carries the icon alone, its name kept for a
// screen reader. While a column is sorted, the sort's arrow stands in its type's icon's place, so
// nothing moves when the sort changes.
const HeadName = <Row,>({
  column,
  header,
  sort,
  stop,
  onSort,
}: HeadNameProps<Row>) => {
  const boxed = column.type === "boolean";
  const inner = (
    <>
      <span
        aria-hidden="true"
        {...stylex.props(
          styles[markStyle[header]],
          sort !== undefined && styles.sortMark
        )}
      >
        <Icon
          icon={
            sort === undefined
              ? (column.icon ?? typeIcon[column.type])
              : sortIcon[sort]
          }
        />
      </span>
      <span {...stylex.props(boxed ? visuallyHidden : styles.words)}>
        {column.header}
      </span>
    </>
  );
  const place = [
    styles.name,
    isFigure(column.type) && styles.nameEnd,
    boxed && styles.nameCentre,
  ];
  if (column.sortable !== true) {
    return <span {...stylex.props(place)}>{inner}</span>;
  }
  return (
    <button
      type="button"
      tabIndex={stop ? 0 : -1}
      onClick={onSort}
      {...stylex.props(
        place,
        styles.sorts,
        styles.sortsReach,
        tapTargetAfter,
        sort !== undefined && styles.sorted,
        focusRingInset,
        styles.sortsRing
      )}
    >
      {inner}
    </button>
  );
};

interface PartProps<Row> {
  grid: Grid<Row>;
  resizable: boolean;
}

const HeadRow = <Row,>({ grid, resizable }: PartProps<Row>) => {
  const { columns, drawn, header, words } = grid;
  const mint = drawn.ranged && drawn.range === "outline";
  const offset = grid.showRowNumbers ? 2 : 1;
  // The heads are one stop: Tab reaches the first that sorts, and the arrows go along the rest.
  const stop = columns.findIndex((column) => column.sortable === true);
  return (
    <tr
      aria-rowindex={1}
      {...stylex.props(
        styles.row,
        styles.headRow,
        styles[headRowStyle[header]]
      )}
    >
      {grid.showRowNumbers && (
        <th
          scope="col"
          aria-colindex={1}
          {...stylex.props(
            styles.head,
            styles.numberHead,
            header === "lifted" && styles.headLifted
          )}
        >
          <span {...stylex.props(visuallyHidden)}>{words.row}</span>
        </th>
      )}
      {columns.map((column, col) => (
        <th
          key={column.key}
          scope="col"
          aria-colindex={col + offset}
          aria-sort={grid.sortOf(column.key)}
          data-head={col}
          tabIndex={column.sortable === true ? undefined : -1}
          {...stylex.props(
            styles.head,
            header === "lifted" && styles.headLifted,
            col === columns.length - 1 && styles.lastCol,
            edgeStyles(linesAt(drawn, -1, col), mint),
            focusRingInset
          )}
        >
          <HeadName
            column={column}
            header={header}
            sort={grid.sortOf(column.key)}
            stop={col === stop}
            onSort={(event) => {
              grid.sort(column.key);
              // The active cell keeps its place in the sorted rows; once they are drawn, bring it
              // clear of the fades at the grid's edges.
              const table = event.currentTarget.closest("[role=grid]");
              requestAnimationFrame(() => {
                table
                  ?.querySelector<HTMLElement>(
                    "[data-row][data-col][tabindex='0']"
                  )
                  ?.scrollIntoView({ block: "nearest", inline: "nearest" });
              });
            }}
          />
          {resizable && (
            <Handle
              label={words.width(column.header)}
              width={ownValue(grid.widths, column.key)}
              onResize={(width) => {
                grid.resize(column.key, width);
              }}
              onAutoFit={() => {
                grid.autoFit(column.key);
              }}
            />
          )}
        </th>
      ))}
    </tr>
  );
};

// ---- Cells -------------------------------------------------------------------------------------

const activeStyle = {
  halo: "activeHalo",
  underline: "activeUnderline",
} as const;

interface EditorProps {
  editing: Editing;
  label: string;
  figure: boolean;
  onType: (text: string) => void;
  onBlur: () => void;
}

// The cell's words, typed in place. It takes focus as it opens: on all its words when the cell
// was opened, after the letter when a letter opened it.
const Editor = ({ editing, label, figure, onType, onBlur }: EditorProps) => {
  const ref = useRef<HTMLInputElement>(null);
  const { all: selectAll } = editing;
  useEffect(() => {
    const input = ref.current;
    input?.focus({ preventScroll: true });
    if (selectAll) {
      input?.select();
    }
  }, [selectAll]);
  return (
    <input
      ref={ref}
      type="text"
      aria-label={label}
      aria-invalid={editing.wrong ? true : undefined}
      autoComplete="off"
      spellCheck={false}
      value={editing.text}
      onChange={(event) => {
        onType(event.currentTarget.value);
      }}
      onBlur={onBlur}
      {...stylex.props(styles.editor, figure && styles.editorEnd)}
    />
  );
};

interface CellProps<Row> {
  grid: Grid<Row>;
  column: DataGridColumn<Row>;
  data: Row;
  row: number;
  col: number;
}

/** Where a cell's value stands and how it reads, by its column's type. */
const typeStyles = (type: DataGridColumnType, editable: boolean) => [
  isFigure(type) && styles.end,
  type === "boolean" && styles.centre,
  type === "boolean" && editable && styles.boxCell,
  (type === "text" || isFigure(type)) && styles.ink,
  !editable && styles.readOnly,
];

/** How the range draws on a cell: its wash, and its edge on the cell's lines. */
const rangeStyles = (
  drawn: Drawn,
  { row, col }: DataGridCell,
  active: boolean
) => {
  const { rect } = drawn;
  const inRange = drawn.ranged && contains(rect, { row, col });
  const mint = drawn.ranged && drawn.range === "outline";
  // The firmer edge's second line, on the sides of a cell that lie on the range's edge. Not on the
  // active cell: its own edge marks it.
  const firm = inRange && mint && !active;
  return [
    inRange && styles.inRange,
    inRange && drawn.range === "dither" && styles.inRangeDither,
    edgeStyles(linesAt(drawn, row, col), mint),
    firm && styles.firm,
    firm && row === rect.top && styles.firmTop,
    firm && row === rect.bottom && styles.firmBottom,
    firm && col === rect.left && styles.firmStart,
    firm && col === rect.right && styles.firmEnd,
  ];
};

/** How the active cell is drawn, while focus is in the grid or its editor is open. */
const activeStyles = (
  look: DataGridActiveAppearance,
  inRange: boolean,
  editing: Editing | null
) => [
  styles.activeBase,
  styles[activeStyle[look]],
  !inRange && look !== "underline" && styles.activeAlone,
  inRange && look === "underline" && styles.activeUnderlineInRange,
  editing !== null && styles.editing,
  editing?.wrong === true && styles.wrong,
];

interface ValueProps {
  value: DataGridCellValue;
  text: string;
  type: DataGridColumnType;
  /** The words stand on a pad of the range's ground, clear of its dither. */
  clear: boolean;
  /** Kept unseen while the editor is open, so the column keeps its width. */
  hidden: boolean;
  words: { ticked: string; unticked: string };
}

// A cell's value as its type shows it: words, a select's chip, or a boolean's box (Checkbox's own
// box, drawn still: the cell is the control, by Space or a press).
const CellValue = ({ value, text, type, clear, hidden, words }: ValueProps) => {
  if (type === "boolean") {
    return (
      <>
        <span
          aria-hidden="true"
          {...stylex.props(choiceBoxStyles.control, styles.box)}
        >
          <span
            {...stylex.props(
              choiceBoxStyles.face,
              value === true ? choiceBoxStyles.full : choiceBoxStyles.empty
            )}
          >
            {value === true && <Icon icon={CheckIcon} />}
          </span>
        </span>
        <span {...stylex.props(visuallyHidden)}>
          {value === true ? words.ticked : words.unticked}
        </span>
      </>
    );
  }
  const chip = type === "select" && text !== "";
  return (
    <span
      {...stylex.props(
        chip ? styles.chip : styles.text,
        clear && (chip ? styles.chipClear : styles.textClear),
        hidden && styles.unseenText
      )}
    >
      {text}
    </span>
  );
};

// One cell: its value, and the editor that opens in place.
const GridCell = <Row,>({ grid, column, data, row, col }: CellProps<Row>) => {
  const { drawn, words } = grid;
  const value = column.value(data);
  const boxed = column.type === "boolean";
  const active = drawn.cell.row === row && drawn.cell.col === col;
  const inRange = drawn.ranged && contains(drawn.rect, { row, col });
  // A grid nobody is in shows no active cell; the cell is kept, and drawn again as focus comes back.
  const lit = active && (drawn.focused || grid.editing !== null);
  const editing =
    grid.editAt?.row === row && grid.editAt.col === col ? grid.editing : null;
  const editable = grid.editable(col);
  const name = words.cell(column.header, row + 1);
  return (
    <td
      aria-colindex={col + (grid.showRowNumbers ? 2 : 1)}
      aria-selected={inRange || active}
      aria-readonly={editable ? undefined : true}
      aria-label={boxed ? name : undefined}
      tabIndex={active ? 0 : -1}
      data-row={row}
      data-col={col}
      onPointerDown={(event) => {
        grid.handlePress(event, { row, col });
      }}
      onPointerEnter={() => {
        grid.handleEnter({ row, col });
      }}
      // Reached by Tab after the grid has scrolled (a sort, a scroll by hand), the active cell is
      // brought clear of the fades at the edges, so its ring is never under one.
      onFocus={(event) => {
        if (event.target === event.currentTarget) {
          event.currentTarget.scrollIntoView({
            block: "nearest",
            inline: "nearest",
          });
        }
      }}
      onClick={(event) => {
        if (boxed && !event.shiftKey) {
          grid.tick({ row, col });
        }
      }}
      onDoubleClick={() => {
        grid.startEdit();
      }}
      {...stylex.props(
        styles.cell,
        typeStyles(column.type, editable),
        col === grid.columns.length - 1 && styles.lastCol,
        row === grid.shown.length - 1 && styles.lastRow,
        rangeStyles(drawn, { row, col }, active),
        lit && activeStyles(drawn.active, inRange, editing)
      )}
    >
      <CellValue
        value={value}
        text={shownOf(column, value, grid.locale)}
        type={column.type}
        clear={inRange && drawn.range === "dither"}
        hidden={editing !== null}
        words={words}
      />
      {editing !== null && (
        <Editor
          editing={editing}
          label={words.edit(name)}
          figure={isFigure(column.type)}
          onType={grid.handleType}
          onBlur={grid.handleEditorBlur}
        />
      )}
    </td>
  );
};

interface RowProps<Row> {
  grid: Grid<Row>;
  data: Row;
  row: number;
}

const GridRow = <Row,>({ grid, data, row }: RowProps<Row>) => {
  const { drawn } = grid;
  return (
    <tr aria-rowindex={row + 2} {...stylex.props(styles.row)}>
      {grid.showRowNumbers && (
        <th
          scope="row"
          aria-colindex={1}
          onPointerDown={(event) => {
            grid.handleRowPress(event, row);
          }}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          {...stylex.props(
            styles.cell,
            styles.number,
            row === grid.shown.length - 1 && styles.lastRow,
            edgeStyles(
              linesAt(drawn, row, -1),
              drawn.ranged && drawn.range === "outline"
            )
          )}
        >
          {row + 1}
        </th>
      )}
      {grid.columns.map((column, col) => (
        <GridCell
          key={column.key}
          grid={grid}
          column={column}
          data={data}
          row={row}
          col={col}
        />
      ))}
    </tr>
  );
};

/** A spreadsheet in the page. */
export const DataGrid = <Row,>(props: DataGridProps<Row>) => {
  const { gridRef, scrollerRef, readEdges, grid } = useDataGrid(props);
  const { edges } = grid;
  const resizable = props.resizable === true;
  return (
    <div
      data-slot="data-grid"
      onFocus={grid.handleFocus}
      onBlur={grid.handleBlur}
      {...stylex.props(styles.frame, props.style)}
    >
      <div
        ref={scrollerRef}
        onScroll={readEdges}
        {...stylex.props(
          styles.scroller,
          grid.showRowNumbers && styles.scrollerNumbered,
          scrollbarHidden
        )}
      >
        <table
          ref={gridRef}
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role -- a table is the element ARIA gives the grid role to: its rows and cells then are the grid's rows and cells
          role="grid"
          tabIndex={-1}
          aria-label={props["aria-label"]}
          aria-multiselectable="true"
          aria-readonly={grid.readOnly ? true : undefined}
          aria-rowcount={grid.shown.length + 1}
          aria-colcount={grid.columns.length + (grid.showRowNumbers ? 1 : 0)}
          onKeyDown={grid.handleKeyDown}
          onCopy={grid.handleCopy}
          onCut={grid.handleCut}
          onPaste={grid.handlePaste}
          {...stylex.props(styles.grid, styles.columns(grid.template))}
        >
          <thead {...stylex.props(styles.group)}>
            <HeadRow grid={grid} resizable={resizable} />
          </thead>
          <tbody {...stylex.props(styles.group)}>
            {grid.shown.map((line, row) => (
              <GridRow key={line.id} grid={grid} data={line.data} row={row} />
            ))}
          </tbody>
        </table>
      </div>
      <div
        aria-hidden="true"
        {...stylex.props(
          styles.fade,
          grid.showRowNumbers ? styles.fadeStartNumbered : styles.fadeStart,
          edges.rtl ? styles.fadeToRight : styles.fadeToLeft,
          edges.start && styles.fadeShown
        )}
      />
      <div
        aria-hidden="true"
        {...stylex.props(
          styles.fade,
          styles.fadeEnd,
          edges.rtl ? styles.fadeToLeft : styles.fadeToRight,
          edges.end && styles.fadeShown
        )}
      />
      <output {...stylex.props(visuallyHidden)}>{grid.said}</output>
    </div>
  );
};
