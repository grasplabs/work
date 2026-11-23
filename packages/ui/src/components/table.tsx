// Table: rows of facts in columns, in StyleX: small text, a hairline between rows,
// the head in muted words, figures that line up, and a soft footer. Plain HTML table elements
// underneath: UI SDK has no table, and a table of facts needs no behaviour.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <Table caption="Reports this quarter.">
//     <TableHeader>
//       <TableRow><TableHead>Report</TableHead><TableHead align="end">Pages</TableHead></TableRow>
//     </TableHeader>
//     <TableBody>
//       <TableRow><TableCell rowHeader>Quarterly summary</TableCell><TableCell align="end">12</TableCell></TableRow>
//     </TableBody>
//   </Table>
//
// A table wider than its column scrolls sideways inside its own box, which then takes focus so the
// keys can scroll it. Every value is a token. A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { createContext, use, useEffect, useId, useRef, useState } from "react";
import type { MouseEvent, ReactNode, ThHTMLAttributes } from "react";

import { useI18n } from "../lib/i18n";
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  Icon,
} from "../lib/icons";
import {
  fadeIn,
  focusCarrier,
  focusRing,
  tapTarget,
  visuallyHidden,
} from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, motionVars } from "../lib/vars.stylex";
import { tableVars } from "./table.stylex";

/** How much room a row has: `compact` 32px, `default` 42px, `comfortable` 50px. The words stay the same. */
export type TableDensity = "compact" | "default" | "comfortable";

/** How a column is sorted. */
export type TableSortDirection = "ascending" | "descending" | "none";

/**
 * A column held in place while the rest scrolls sideways: at the `start` or the `end`, `offset`
 * from that edge (a CSS length: the widths of the held columns before it). `edge` marks the one
 * nearest the scrolling columns: it casts the low lift while something is scrolled under it.
 */
export interface TablePin {
  side: "start" | "end";
  offset: string;
  edge?: boolean;
  /** Drawn above the held cells after it, which its control's reach spills into (a checkbox). */
  above?: boolean;
}

/** Every prop a Table takes. */
export interface TableProps {
  /** The head, the body and the footer: TableHeader, TableBody and TableFooter. */
  children: ReactNode;
  /**
   * What the table holds, in a short sentence under it. It names the table for a screen reader
   * and an agent. Leave it out only when a heading right above names it, and pass `aria-label`.
   */
  caption?: ReactNode;
  /** The table's name when it has no caption, for a screen reader and an agent. */
  "aria-label"?: string;
  /**
   * How much room a row has: `compact` 32px, `default` 42px, `comfortable` 50px.
   * @default "default"
   */
  density?: TableDensity;
  /**
   * The tallest the table's box grows (a CSS length, "28rem"); taller, its rows scroll inside it
   * and the head stays in view, casting the low lift while rows are under it.
   */
  height?: string;
  /**
   * The table's width in pixels, when its columns are sized (a data table that resizes or pins):
   * the columns then keep their widths and the table lays out at once, without measuring words.
   */
  width?: number;
  /**
   * A side with more columns beyond it fades out, since the box shows no scrollbar. A table with
   * held columns turns it off: their lift says it instead. The foot of a table with a height fades
   * while rows lie below it either way.
   * @default true
   */
  fade?: boolean;
  /**
   * Its rows arrive one at a time (an answer being written): the columns share the width evenly,
   * so no row that comes moves the ones above it. Keep it on once the table is whole and nothing
   * moves then either.
   */
  streaming?: boolean;
  /** Something after the table, inside its box: a data table's mark for endless loading. */
  bottomContent?: ReactNode;
  /** Layout only: its width and where it sits. */
  style?: LayoutStyle;
}

/** Every prop a TableCaption takes. */
export interface TableCaptionProps {
  /** What the table holds, in a short sentence. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a TableHeader takes. */
export interface TableHeaderProps {
  /** One TableRow of TableHead cells. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a TableBody takes. */
export interface TableBodyProps {
  /** The rows: one TableRow for each thing the table lists. */
  children: ReactNode;
  /**
   * The rows have just replaced their placeholders: they fade in where those stood, and nothing
   * moves. Leave it off on the first paint.
   * @default false
   */
  animateIn?: boolean;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a TableFooter takes. */
export interface TableFooterProps {
  /** One TableRow: a total or a count for the rows above. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a TableRow takes. */
export interface TableRowProps {
  /** The row's cells: TableHead in the head, TableCell everywhere else. */
  children: ReactNode;
  /**
   * The row is selected, for instance by a checkbox in its first cell: it keeps a quiet fill. Say
   * it in the row as well; the fill alone is not enough.
   * @default false
   */
  selected?: boolean;
  /**
   * Shown. `false` keeps it for its widths only: not drawn, not read, not reached, while the
   * columns keep the sizes it gives them (a data table keeps its rows so while a search matches
   * none, so the columns do not jump as you type).
   * @default true
   */
  open?: boolean;
  /**
   * The row opens something: one link or button in it (`data-row-target`) stretches its press area
   * over the row, and the row takes the keyboard's ring while that has focus.
   * @default false
   */
  interactive?: boolean;
  /**
   * The row open now, in a page that shows one row's panel beside the table: said as current, with
   * the pointer's quiet fill kept. Not the selection: that is `selected`.
   * @default false
   */
  current?: boolean;
  /**
   * The row's state, drawn over the whole row: `pending` fades from its start to its end (someone
   * invited, not yet here); `removed` greys it. Say the state in the row's words as well; the look
   * alone is not enough. A control in the row that must stay usable stands above the veil: give it
   * `position: "relative"` and a `zIndex` of 1 in its `style`.
   */
  status?: "pending" | "removed";
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a TableHead takes. */
export interface TableHeadProps {
  /** The column's name, short and in sentence case ("Last edited"). */
  children?: ReactNode;
  /**
   * Where the name stands: `end` over a column of figures, so it lines up with them; `center`
   * over a column of short marks.
   * @default "start"
   */
  align?: "start" | "center" | "end";
  /** The name of a column whose head shows no words, such as a column of actions. */
  "aria-label"?: string;
  /**
   * How the column is sorted now. You own the sort: sort the rows yourself and pass it here, on
   * every sortable column (`none` on the others).
   */
  sortDirection?: TableSortDirection;
  /**
   * Runs when the column's name is pressed: sort the rows by it, or turn the sort over. The press
   * comes with it, so Shift can add the column to a sort by several.
   */
  onSort?: (event: MouseEvent<HTMLButtonElement>) => void;
  /**
   * Where the column stands in a sort by several columns, from 1. Shown after the sort's icon, and
   * said, when more than one column is sorted.
   */
  sortIndex?: number;
  /** Held in place while the other columns scroll sideways (a data table's pinned column). */
  pin?: TablePin;
  /** The column's width in pixels, in a table whose columns are sized. */
  width?: number;
  /** The column's key in code, as `data-column`, for a script or a test that finds it. */
  column?: string;
  /** Controls at the head's end, after the name: a column's menu, a handle to resize it. */
  actions?: ReactNode;
  /** Dragging the head moves the column (a data table that reorders); the drop's own events. */
  drag?: Pick<
    ThHTMLAttributes<HTMLTableCellElement>,
    | "draggable"
    | "onDragStart"
    | "onDragOver"
    | "onDragLeave"
    | "onDrop"
    | "onDragEnd"
  > & { "data-drop"?: "before" | "after" };
  /**
   * The column goes when the table's own box is narrower than the `sm` (40rem) or `md` (48rem)
   * breakpoint: measured on the table's box, not the window. What it holds must also be somewhere
   * else in the row or a step away, never only here.
   */
  hideBelow?: "sm" | "md";
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a TableCell takes. */
export interface TableCellProps {
  /** The fact: words, a figure, or a small control. */
  children?: ReactNode;
  /**
   * Where it stands: `end` for figures, so their units line up; `center` for short marks.
   * @default "start"
   */
  align?: "start" | "center" | "end";
  /**
   * The cell that says what the row is, usually the first: in ink, and read as the row's name by a
   * screen reader.
   * @default false
   */
  rowHeader?: boolean;
  /**
   * How many columns it spans, as in a footer's "Total" label.
   * @default 1
   */
  colSpan?: number;
  /** Held in place while the other columns scroll sideways (a data table's pinned column). */
  pin?: TablePin;
  /**
   * Its words stop at the column's edge with an ellipsis, in a table whose columns are sized. Give
   * the whole text as `title`, so what the ellipsis hides can still be read.
   * @default false
   */
  truncate?: boolean;
  /** The cell's whole text, shown on hover where `truncate` cuts it short. */
  title?: string;
  /**
   * Its words may wrap onto more lines: a cell that holds a sentence. Only the row header wraps by
   * itself; every other cell (a figure, a date, a name, a badge) stays on one line, and a table
   * too narrow for its rows scrolls sideways inside its box.
   * @default false
   */
  wrap?: boolean;
  /**
   * The column goes when the table's own box is narrower than the `sm` (40rem) or `md` (48rem)
   * breakpoint: measured on the table's box, not the window. What it holds must also be somewhere
   * else in the row or a step away, never only here.
   */
  hideBelow?: "sm" | "md";
  /**
   * It stays in view under the table's head while the rows under it scroll, in a table whose rows
   * scroll inside its box: a group's heading.
   * @default false
   */
  sticky?: boolean;
  /** Layout only. */
  style?: LayoutStyle;
}

// What the table says to its parts: which section a row stands in (a body row lights under a
// pointer and leaves its last hairline to the footer, a head row does neither), its density, and
// whether its head stays in view. Plain values, each in its own context, so no object is built for
// them on every render.
const SectionContext = createContext<"head" | "body" | "foot">("body");
const DensityContext = createContext<TableDensity>("default");
const StickyHeadContext = createContext(false);

// Values only the moment knows: where a held column stands, how wide a sized one is, how tall the
// box may grow. Given as StyleX values, never as an inline style.
const place = stylex.create({
  start: (offset: string) => ({ insetInlineStart: offset }),
  end: (offset: string) => ({ insetInlineEnd: offset }),
  width: (width: string) => ({ width }),
  tall: (height: string) => ({ maxBlockSize: height }),
});

const HOVER = media.hover;
const FORCED = media.forcedColors;
// The keyboard's focus on the name that opens a row.
const ROW_FOCUS =
  ":has([data-row-target]:focus-visible:not([data-focus-pointer]))";
const selectedFill = `linear-gradient(${colors.tableRowBgSelectedMint}, ${colors.tableRowBgSelectedMint})`;
const hoverFill = `linear-gradient(${colors.tableRowBgHover}, ${colors.tableRowBgHover})`;
const headLine = `linear-gradient(to top, ${colors.border} ${size.hairline}, transparent ${size.hairline})`;

const styles = stylex.create({
  // What holds the box. The box fades at an edge with more beyond it (a mask), and a mask would
  // fade its own focus ring too: so the ring is drawn here (ring, below), over the box.
  frame: {
    position: "relative",
    width: "100%",
    maxWidth: "100%",
    minWidth: 0,
    borderRadius: tableVars.corner,
    cornerShape: radius.shape,
  },
  // The box and its ring stand in this, so the ring lies over the box alone.
  box: {
    position: "relative",
    borderRadius: tableVars.corner,
    cornerShape: radius.shape,
  },
  // The ring: a part of its own laid over the box, above the head's fill and a held column, which
  // would hide a ring drawn under them. Shown while the box before it has the keyboard's focus.
  ring: {
    position: "absolute",
    inset: 0,
    zIndex: 5,
    borderRadius: "inherit",
    cornerShape: "inherit",
    pointerEvents: "none",
    outlineWidth: size.ringWidth,
    outlineColor: colors.ring,
    outlineStyle: { default: "none", ":is(:focus-visible + *)": "solid" },
    // Off the box, on the page's own ground, as a mark's ring stands off its edge: drawn on the
    // edge, it lay over the head's and the rows' fills and read against them, not against the page.
    outlineOffset: size.ringOffsetMark,
  },
  // The box round the table. A table wider than its column scrolls sideways inside it, never the
  // page. When it scrolls it takes focus, so the keys can scroll it too.
  scroller: {
    position: "relative",
    // A container of its own size, so a row that speaks for the whole table (nothing found, it
    // failed) can stand as wide as the box shows, not as wide as the table runs.
    containerType: "inline-size",
    width: "100%",
    maxWidth: "100%",
    overflowX: "auto",
    // Never down, but for a table with a height (tall): sideways alone, overflow-y would be auto
    // too, and a table a pixel taller than its box made the box a scroller Firefox stops on by Tab
    // with nothing to scroll and no ring.
    overflowY: "hidden",
    overscrollBehaviorX: "contain",
    borderRadius: tableVars.corner,
    cornerShape: radius.shape,
    // No scrollbar: the edge that has more to scroll fades instead (fade).
    scrollbarWidth: "none",
  },
  // The edge with more beyond it fades out over table-fade, so the table says it scrolls without a
  // bar: a side with columns beyond it, and the foot of a table with a height while rows lie below
  // it. Two layers, the sides' and the foot's, kept where both are black. Off at the sides where
  // columns are held: their lift says it instead, and a fade would dim them.
  fade: {
    "--table-fade-x": "linear-gradient(black, black)",
    "--table-fade-y": {
      default: "linear-gradient(black, black)",
      ":is([data-under-foot])": `linear-gradient(to bottom, black calc(100% - ${space.tableFade}), transparent)`,
    },
    maskImage: {
      default: null,
      ":is([data-under-start], [data-under-end], [data-under-foot])":
        "var(--table-fade-x), var(--table-fade-y)",
    },
    maskComposite: "intersect",
  },
  // The sides' layer, where no column is held.
  fadeSides: {
    "--table-fade-x": {
      default: "linear-gradient(black, black)",
      ":is([data-under-end]:not([data-under-start]))": `linear-gradient(to right, black calc(100% - ${space.tableFade}), transparent)`,
      ":is([data-under-start]:not([data-under-end]))": `linear-gradient(to left, black calc(100% - ${space.tableFade}), transparent)`,
      ":is([data-under-start][data-under-end])": `linear-gradient(to right, transparent, black ${space.tableFade}, black calc(100% - ${space.tableFade}), transparent)`,
      ":is([dir=rtl] *):is([data-under-end]:not([data-under-start]))": `linear-gradient(to left, black calc(100% - ${space.tableFade}), transparent)`,
      ":is([dir=rtl] *):is([data-under-start]:not([data-under-end]))": `linear-gradient(to right, black calc(100% - ${space.tableFade}), transparent)`,
    },
  },
  // A table with a height: its rows scroll inside the box, under a head that stays.
  tall: {
    overflowY: "auto",
    overscrollBehaviorY: "auto",
  },
  table: {
    width: "100%",
    margin: 0,
    borderCollapse: "collapse",
    borderSpacing: 0,
    fontFamily: font.sans,
    fontSize: tableVars.text,
    lineHeight: tableVars.line,
    color: colors.bodyForeground,
    // Figures line up from row to row.
    fontVariantNumeric: "tabular-nums",
  },
  // Rows that arrive one at a time, and columns sized by a data table: even or given widths, laid
  // out at once, so no row that comes moves the ones above it.
  fixed: { tableLayout: "fixed" },
  sized: { maxWidth: "none" },
  // A TableCaption written into the table: under it, as a table's caption.
  captionUnder: { captionSide: "bottom" },
  // The caption a reader sees: under the box, still and whole while the table scrolls sideways.
  caption: {
    margin: 0,
    fontFamily: font.sans,
    marginBlockStart: space[4],
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
    textAlign: "start",
  },
  // Every row has a hairline under it (the table's borders collapse, so a row can carry one).
  row: {
    borderBlockEndWidth: {
      default: size.hairline,
      // A head row whose cells all draw the line themselves (held heads) leaves its own off: both
      // drew one, a pixel apart, and the line under the head read double.
      ":has(> [data-own-line]):not(:has(> :not([data-own-line])))": 0,
      // The footer's last row leaves it off: the table ends there.
      ":is(tfoot > :last-child)": 0,
      // The head's line is drawn by its cells (head), not by a collapsed border: WebKit painted that
      // border twice over a column of row headers and the line was darker there.
      ":is(thead > *)": 0,
    },
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
  },
  // A cell that stays in view under the table's head while the rows under it scroll (a group's
  // heading), in a table whose rows scroll inside its box: on the table's ground, under the head.
  stickyCell: {
    position: "sticky",
    top: size.tableHeadHeight,
    zIndex: 1,
    backgroundColor: colors.background,
  },
  stickyCompact: { top: size.tableHeadHeightCompact },
  // A column that goes when the table's own box (the scroller, a container) is narrower than the
  // sm or md breakpoint.
  hideBelowSm: {
    display: { default: null, "@container (width < 40rem)": "none" },
  },
  hideBelowMd: {
    display: { default: null, "@container (width < 48rem)": "none" },
  },
  // A row's state drawn over the whole row, never per cell, so it does not break at a column: a
  // veil of the table's ground laid on top. Pending fades from the start, where the row is whole,
  // to its end, the words still readable; mirrored right to left. Removed lays the ground evenly
  // over the whole row, pictures included.
  statusRow: {
    position: "relative",
    "--table-row-fade": { default: "to right", ":dir(rtl)": "to left" },
    "::after": {
      content: '""',
      position: "absolute",
      insetInline: 0,
      insetBlockStart: 0,
      // Clear of the hairline under the row, which keeps its own strength.
      insetBlockEnd: size.hairline,
      pointerEvents: "none",
    },
  },
  statusPending: {
    "::after": {
      backgroundImage: `linear-gradient(var(--table-row-fade), transparent 20%, color-mix(in oklab, ${colors.background} 70%, transparent))`,
    },
  },
  // Greyed by the ground itself, not a filter: a filter greyed the ground too, and in dark the row
  // stood as a grey band on the green ground.
  statusRemoved: {
    "::after": {
      backgroundColor: `color-mix(in oklab, ${colors.background} 55%, transparent)`,
    },
  },
  // A row kept for its widths: it takes no room and is not drawn, but its cells still size the columns.
  collapsed: { visibility: "collapse" },
  // A row of the body: lit under a pointer, and its last one leaves the hairline to the footer.
  bodyRow: {
    borderBlockEndWidth: { default: size.hairline, ":last-child": 0 },
    // The fill is drawn as an image and meets the hairlines above and below it, sized from the
    // row's border box, which holds its half of the collapsed hairline.
    backgroundImage: {
      default: null,
      ":hover": { default: null, [HOVER]: hoverFill },
    },
    backgroundSize: "100% 100%",
    backgroundOrigin: "border-box",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    transitionProperty: "background-image",
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
  },
  // A row that opens something: the box its name's press area stretches over, and the keyboard's
  // ring round the whole row while that name has focus, inside the table.
  interactive: {
    position: "relative",
    cursor: "pointer",
    outlineStyle: { default: "none", [ROW_FOCUS]: "solid" },
    outlineWidth: size.ringWidth,
    outlineColor: { default: colors.ring, [FORCED]: "Highlight" },
    outlineOffset: `calc(-1 * ${size.ringWidth})`,
  },
  // The row open now (its panel shows): the pointer's quiet fill kept, so it is told from the rest
  // without the selection's fill. In forced colours a line round it, which the keyboard's ring
  // replaces while its name has focus. Every outline value is restated, the ring's included: a
  // later style's outline replaces the whole of the interactive row's.
  current: {
    backgroundImage: hoverFill,
    outlineStyle: { default: "none", [ROW_FOCUS]: "solid", [FORCED]: "solid" },
    outlineWidth: {
      default: size.ringWidth,
      [FORCED]: { default: size.hairline, [ROW_FOCUS]: size.lineStrong },
    },
    outlineColor: {
      default: colors.ring,
      [FORCED]: { default: "CanvasText", [ROW_FOCUS]: "Highlight" },
    },
    outlineOffset: {
      default: `calc(-1 * ${size.ringWidth})`,
      [FORCED]: {
        default: `calc(-1 * ${size.hairline})`,
        [ROW_FOCUS]: `calc(-1 * ${size.lineStrong})`,
      },
    },
  },
  // Selected: a soft mint wash, drawn as an image, which forced colours drop, so the system's
  // highlight there. Under a pointer it deepens a step, as every row answers the pointer.
  selected: {
    backgroundImage: {
      default: selectedFill,
      ":hover": { default: null, [HOVER]: `${hoverFill}, ${selectedFill}` },
    },
    backgroundColor: { default: null, [FORCED]: "Highlight" },
    color: { default: null, [FORCED]: "HighlightText" },
  },
  // The footer sits on the soft ground, its words in ink, with a hairline above it.
  footer: {
    backgroundColor: colors.muted,
    borderBlockStartWidth: size.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
    color: colors.foreground,
    fontWeight: font.weightMedium,
  },
  head: {
    height: size.tableHeadHeight,
    boxSizing: "border-box",
    // The head's line, drawn by each cell along its foot: one line in every engine (row).
    backgroundImage: headLine,
    paddingBlock: 0,
    paddingInline: space.tableCellInline,
    textAlign: "start",
    verticalAlign: "middle",
    fontSize: font.textSm,
    fontWeight: font.weightMedium,
    color: colors.tableHeadForeground,
    whiteSpace: "nowrap",
  },
  // A head with controls after its name (a column's menu, a resize handle): they sit at its end.
  headWithActions: {
    position: "relative",
    paddingInlineEnd: space[1],
  },
  headCompact: { height: size.tableHeadHeightCompact },
  // Where a dragged column will land: a pine line on that side of the head.
  dropBefore: {
    boxShadow: {
      default: `inset ${size.lineStrong} 0 0 ${colors.pine}`,
      ":is([dir=rtl] *)": `inset calc(-1 * ${size.lineStrong}) 0 0 ${colors.pine}`,
    },
  },
  dropAfter: {
    boxShadow: {
      default: `inset calc(-1 * ${size.lineStrong}) 0 0 ${colors.pine}`,
      ":is([dir=rtl] *)": `inset ${size.lineStrong} 0 0 ${colors.pine}`,
    },
  },
  // A column that can be sorted: its name is a button, with the sort's icon after it.
  sort: {
    // Reached by Tab, it is scrolled clear of the fade at the box's edges, so its ring is whole.
    scrollMarginInline: `calc(${space.tableFade} + ${space[2]})`,
    position: "relative",
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "inline-flex",
    alignItems: "center",
    gap: space[1],
    margin: 0,
    marginInline: `calc(-1 * ${space[1]})`,
    paddingBlock: 0,
    paddingInline: space[1],
    borderWidth: 0,
    borderRadius: radius.mark,
    cornerShape: radius.shape,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: colors.accent },
    },
    color: {
      default: "inherit",
      ":hover": { default: null, [HOVER]: colors.foreground },
    },
    fontFamily: "inherit",
    fontSize: "inherit",
    fontWeight: "inherit",
    lineHeight: "inherit",
    cursor: "pointer",
  },
  sorted: { color: colors.foreground },
  // A column's place in a sort by several, in a small muted figure after its icon.
  sortIndex: {
    fontSize: font.textXs,
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
  },
  // The icon of a column not sorted yet is quieter than the words.
  unsorted: { opacity: 0.6 },
  cell: {
    paddingBlock: space.tableCellBlock,
    paddingInline: space.tableCellInline,
    textAlign: "start",
    verticalAlign: "middle",
    // Words stay whole: a table too narrow for them scrolls sideways (the box), it never breaks a
    // word in two. Only a word wider than a column of a given width breaks.
    overflowWrap: "break-word",
    hyphens: "manual",
  },
  // Every cell but the row header (and one asked to wrap) on one line: on a phone the row header
  // gives way first, in whole words, and when the row still does not fit the box scrolls sideways.
  oneLine: { whiteSpace: "nowrap" },
  // A column of figures stands at the end, so units line up.
  end: { textAlign: "end" },
  centre: { textAlign: "center" },
  // The words that say what the row is. It keeps a least width: in a table too narrow for its
  // columns it was squeezed to a word a line while the table already scrolled sideways.
  rowHeader: {
    color: colors.foreground,
    fontWeight: "inherit",
    minWidth: size.tableLeadMin,
  },
  // Density: the room above and below the words; the words stay the same.
  compact: { paddingBlock: size.tableCellBlockCompact },
  comfortable: { paddingBlock: space.tableCellBlockComfortable },
  // A head that stays in view while rows scroll under it, casting the low lift only then. The
  // lift is clipped to the head's lower side, so it reads as one edge, not a frame.
  stuck: {
    position: "sticky",
    top: 0,
    zIndex: 2,
    backgroundColor: colors.background,
    // The hairline under the head travels with it (a collapsed border would stay behind).
    backgroundImage: headLine,
    boxShadow: { default: null, ":is([data-under-head] *)": shadow.sm },
    // A pixel wider at each side than the cell: clipped on its own box, two cells meeting on a
    // fractional pixel each half-covered it, and Firefox and WebKit showed the page's ground there.
    clipPath: `inset(0 -1px calc(-1 * ${space[3]}) -1px)`,
    // That pixel past each side showed the lift's edge while rows were under the head. The cell's
    // own ground, a pixel wider at each side, lies over its lift and under its words.
    "::before": {
      content: '""',
      position: "absolute",
      insetBlock: 0,
      insetInline: "-1px",
      zIndex: -1,
      backgroundColor: "inherit",
      backgroundImage: "inherit",
      pointerEvents: "none",
    },
  },
  // A column held at the start or the end while the rest scroll sideways. Its ground is the
  // table's, with the row's hover and selected fills drawn again over it, so the band runs unbroken.
  pinned: {
    position: "sticky",
    zIndex: 1,
    backgroundColor: colors.background,
    backgroundImage: {
      default: null,
      ":is([data-slot=table-row]:hover > *)": {
        default: null,
        [HOVER]: hoverFill,
      },
      ":is([data-state=selected] > *)": selectedFill,
    },
    backgroundSize: "100% 100%",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
  },
  // A held head cell: the head's hairline, drawn by the cell itself.
  pinnedHead: {
    backgroundImage: headLine,
    backgroundSize: "100% 100%",
  },
  // A held cell whose control reaches into the held cell after it: drawn above that one.
  aboveBody: { zIndex: 2 },
  aboveHead: { zIndex: 4 },
  // Held in a head that also stays: above both the head and the held body cells.
  corner: {
    zIndex: 3,
    clipPath: {
      default: `inset(0 calc(-1 * ${space[3]}) calc(-1 * ${space[3]}) 0)`,
      ":is([dir=rtl] *)": `inset(0 0 calc(-1 * ${space[3]}) calc(-1 * ${space[3]}))`,
    },
  },
  // The held column nearest the scrolling ones: the low lift on its open side, while a column is
  // under it. Clipped to that side.
  edgeStart: {
    boxShadow: { default: null, ":is([data-under-start] *)": shadow.sm },
    clipPath: {
      default: `inset(0 calc(-1 * ${space[3]}) 0 0)`,
      ":is([dir=rtl] *)": `inset(0 0 0 calc(-1 * ${space[3]}))`,
    },
  },
  edgeEnd: {
    boxShadow: { default: null, ":is([data-under-end] *)": shadow.sm },
    clipPath: {
      default: `inset(0 0 0 calc(-1 * ${space[3]}))`,
      ":is([dir=rtl] *)": `inset(0 calc(-1 * ${space[3]}) 0 0)`,
    },
  },
  // A sized column's words stop at its edge rather than widen it.
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

// Watches the box: whether it scrolls at all (then it is a named region the keys can scroll), and
// what is scrolled under its held parts, as attributes their styles read (no render per frame):
// rows under the head, rows below the foot, columns under a held start or end.
const watch = (
  element: HTMLDivElement,
  setScrolls: (scrolls: boolean) => void
) => {
  const mark = () => {
    const along = Math.abs(element.scrollLeft);
    setScrolls(
      element.scrollWidth > element.clientWidth + 1 ||
        element.scrollHeight > element.clientHeight + 1
    );
    element.toggleAttribute("data-under-head", element.scrollTop > 0);
    element.toggleAttribute("data-under-start", along > 0);
    element.toggleAttribute(
      "data-under-end",
      along < element.scrollWidth - element.clientWidth - 1
    );
    element.toggleAttribute(
      "data-under-foot",
      element.scrollTop < element.scrollHeight - element.clientHeight - 1
    );
  };
  // Marked by the observer only: it reports the box once when it starts watching, after the page
  // is laid out, so a table that mounts while an answer streams forces no layout of its own.
  const observer = new ResizeObserver(mark);
  observer.observe(element);
  if (element.firstElementChild !== null) {
    observer.observe(element.firstElementChild);
  }
  element.addEventListener("scroll", mark, { passive: true });
  return () => {
    observer.disconnect();
    element.removeEventListener("scroll", mark);
  };
};

/** Whether a caption was given (a node that draws something). */
const isGiven = (caption: ReactNode) =>
  caption !== undefined && caption !== null && caption !== false;

/** The table, in a box that scrolls sideways when the table is wider than its column. */
export const Table = ({
  children,
  caption,
  "aria-label": label,
  density = "default",
  height,
  width,
  fade = true,
  streaming,
  bottomContent,
  style,
}: TableProps) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const captionId = useId();
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const element = boxRef.current;
    const stop = element === null ? undefined : watch(element, setScrolls);
    return () => {
      stop?.();
    };
  }, []);
  const hasCaption = isGiven(caption);
  const named = hasCaption
    ? { "aria-labelledby": captionId }
    : { "aria-label": label };
  return (
    <div data-slot="table-frame" {...stylex.props(styles.frame, style)}>
      {/* The box and its ring, together: the ring lies over the box alone, not the caption. */}
      <div {...stylex.props(styles.box)}>
        <div
          ref={boxRef}
          data-slot="table-container"
          tabIndex={scrolls ? 0 : undefined}
          role={scrolls ? "region" : undefined}
          {...(scrolls ? named : {})}
          {...stylex.props(
            styles.scroller,
            styles.fade,
            fade && styles.fadeSides,
            height !== undefined && styles.tall,
            height !== undefined && place.tall(height),
            focusCarrier
          )}
        >
          <table
            data-slot="table"
            data-density={density === "default" ? undefined : density}
            aria-label={hasCaption ? undefined : label}
            {...stylex.props(
              styles.table,
              (streaming === true || width !== undefined) && styles.fixed,
              width !== undefined && styles.sized,
              width !== undefined && place.width(`${String(width)}px`)
            )}
          >
            {/* The caption names the table for a screen reader here, unseen; the words a reader
              sees stand under the box (below), so the box's ring and its sideways scroll leave
              them alone. */}
            {hasCaption && (
              <caption id={captionId} {...stylex.props(visuallyHidden)}>
                {caption}
              </caption>
            )}
            <DensityContext value={density}>
              <StickyHeadContext value={height !== undefined}>
                {children}
              </StickyHeadContext>
            </DensityContext>
          </table>
          {bottomContent}
        </div>
        <span
          aria-hidden="true"
          data-slot="table-focus-ring"
          {...stylex.props(styles.ring)}
        />
      </div>
      {hasCaption && (
        <p
          aria-hidden="true"
          data-slot="table-caption"
          {...stylex.props(styles.caption)}
        >
          {caption}
        </p>
      )}
    </div>
  );
};

/** What the table holds, under it. Prefer Table's `caption`, which also names the scroll box. */
export const TableCaption = ({ children, style }: TableCaptionProps) => (
  <caption
    data-slot="table-caption"
    {...stylex.props(styles.caption, styles.captionUnder, style)}
  >
    {children}
  </caption>
);

/** The head of the table: the row that names its columns. */
export const TableHeader = ({ children, style }: TableHeaderProps) => (
  <thead data-slot="table-header" {...stylex.props(style)}>
    <SectionContext value="head">{children}</SectionContext>
  </thead>
);

/** The rows of the table. A row is lit under a pointer. */
export const TableBody = ({
  children,
  animateIn = false,
  style,
}: TableBodyProps) => (
  <tbody data-slot="table-body" {...stylex.props(animateIn && fadeIn, style)}>
    <SectionContext value="body">{children}</SectionContext>
  </tbody>
);

/** The footer: a total or a count, on the soft ground, in ink. */
export const TableFooter = ({ children, style }: TableFooterProps) => (
  <tfoot data-slot="table-footer" {...stylex.props(styles.footer, style)}>
    <SectionContext value="foot">{children}</SectionContext>
  </tfoot>
);

/** A row, with a hairline under it. In the body it is lit under a pointer. */
export const TableRow = ({
  children,
  selected = false,
  open = true,
  interactive = false,
  current = false,
  status,
  style,
}: TableRowProps) => {
  const section = use(SectionContext);
  return (
    <tr
      data-slot="table-row"
      data-state={selected ? "selected" : undefined}
      data-status={status}
      aria-current={current ? "true" : undefined}
      aria-hidden={open ? undefined : true}
      inert={open ? undefined : true}
      {...stylex.props(
        !open && styles.collapsed,
        styles.row,
        section === "body" && styles.bodyRow,
        interactive && styles.interactive,
        current && styles.current,
        selected && styles.selected,
        status !== undefined && styles.statusRow,
        status === "pending" && styles.statusPending,
        status === "removed" && styles.statusRemoved,
        style
      )}
    >
      {children}
    </tr>
  );
};

/** Where a held cell stands, and how wide a sized one is, as StyleX values. */
const placeOf = (pin: TablePin | undefined, width?: number) => [
  pin?.side === "start" && place.start(pin.offset),
  pin?.side === "end" && place.end(pin.offset),
  width !== undefined && place.width(`${String(width)}px`),
];

/** A column that goes below a breakpoint of the table's box (TableHead, TableCell). */
const hideOf = (below: "sm" | "md" | undefined) => [
  below === "sm" && styles.hideBelowSm,
  below === "md" && styles.hideBelowMd,
];

/** How a held cell looks: on the table's ground, its lift on its open side. */
const pinOf = (pin: TablePin | undefined) => [
  pin !== undefined && styles.pinned,
  pin?.edge === true && pin.side === "start" && styles.edgeStart,
  pin?.edge === true && pin.side === "end" && styles.edgeEnd,
];

/** Where a head's or a cell's words stand. */
const alignOf = (align: "start" | "center" | "end") => [
  align === "end" && styles.end,
  align === "center" && styles.centre,
];

/** A held head among the other held parts: above them when it stays and is held. */
const heldHeadOf = (pin: TablePin | undefined, stickyHead: boolean) => [
  pinOf(pin),
  pin !== undefined && styles.pinnedHead,
  stickyHead && pin !== undefined && styles.corner,
  pin?.above === true && (stickyHead ? styles.aboveHead : styles.aboveBody),
];

/** Where a dragged column will land, beside this head. */
const dropOf = (drop: "before" | "after" | undefined) => [
  drop === "before" && styles.dropBefore,
  drop === "after" && styles.dropAfter,
];

/** A cell that stays in view under the head, below its height at this density. */
const stickyOf = (sticky: boolean, density: TableDensity) => [
  sticky && styles.stickyCell,
  sticky && density === "compact" && styles.stickyCompact,
];

const sortIcons = {
  ascending: ArrowUpIcon,
  descending: ArrowDownIcon,
  none: ArrowUpDownIcon,
} as const;

interface SortButtonProps {
  children?: ReactNode;
  direction: TableSortDirection;
  onSort: (event: MouseEvent<HTMLButtonElement>) => void;
  sortIndex?: number;
}

/** A sortable column's name: a button, with the sort's icon and its place in a sort by several. */
const SortButton = ({
  children,
  direction,
  onSort,
  sortIndex,
}: SortButtonProps) => {
  const { table } = useI18n();
  const placeId = useId();
  const sortPlace = direction === "none" ? undefined : sortIndex;
  return (
    <>
      <button
        type="button"
        onClick={onSort}
        // Its place in a sort by several is said after its name, as a phrase of its own.
        aria-describedby={sortPlace === undefined ? undefined : placeId}
        // Reached by Tab, scrolled clear of the box's fades (its scroll margin), so its ring is whole.
        onFocus={(event) => {
          event.currentTarget.scrollIntoView({
            block: "nearest",
            inline: "nearest",
          });
        }}
        {...stylex.props(
          styles.sort,
          direction !== "none" && styles.sorted,
          focusRing
        )}
      >
        <span aria-hidden="true" {...stylex.props(tapTarget)} />
        {children}
        <span {...stylex.props(direction === "none" && styles.unsorted)}>
          <Icon icon={sortIcons[direction]} />
        </span>
        {sortPlace !== undefined && (
          <span aria-hidden="true" {...stylex.props(styles.sortIndex)}>
            {sortPlace}
          </span>
        )}
      </button>
      {sortPlace !== undefined && (
        <span id={placeId} {...stylex.props(visuallyHidden)}>
          {table.sortIndex(sortPlace)}
        </span>
      )}
    </>
  );
};

/** The name of a column. It labels every cell under it for a screen reader. */
export const TableHead = ({
  children,
  align = "start",
  "aria-label": label,
  sortDirection,
  onSort,
  sortIndex,
  pin,
  width,
  actions,
  drag,
  column,
  hideBelow,
  style,
}: TableHeadProps) => {
  const density = use(DensityContext);
  const stickyHead = use(StickyHeadContext);
  const direction = sortDirection ?? "none";
  return (
    <th
      data-slot="table-head"
      // A head that stays in view or is held draws the head's line itself (stuck, pinnedHead); a
      // row whose heads all do leaves its own off.
      data-own-line={stickyHead || pin !== undefined ? "" : undefined}
      scope="col"
      aria-label={label}
      aria-sort={
        onSort !== undefined && direction !== "none" ? direction : undefined
      }
      data-column={column}
      {...drag}
      {...stylex.props(
        styles.head,
        actions !== undefined && styles.headWithActions,
        density === "compact" && styles.headCompact,
        alignOf(align),
        stickyHead && styles.stuck,
        heldHeadOf(pin, stickyHead),
        dropOf(drag?.["data-drop"]),
        placeOf(pin, width),
        hideOf(hideBelow),
        style
      )}
    >
      {onSort === undefined ? (
        children
      ) : (
        <SortButton direction={direction} onSort={onSort} sortIndex={sortIndex}>
          {children}
        </SortButton>
      )}
      {actions}
    </th>
  );
};

/** One fact in a row. The row header names the row. */
export const TableCell = ({
  children,
  align = "start",
  rowHeader = false,
  colSpan,
  pin,
  truncate = false,
  title,
  wrap = false,
  hideBelow,
  sticky = false,
  style,
}: TableCellProps) => {
  const density = use(DensityContext);
  const look = stylex.props(
    styles.cell,
    density === "compact" && styles.compact,
    density === "comfortable" && styles.comfortable,
    rowHeader && styles.rowHeader,
    !rowHeader && !wrap && styles.oneLine,
    alignOf(align),
    truncate && styles.truncate,
    pinOf(pin),
    pin?.above === true && styles.aboveBody,
    placeOf(pin),
    hideOf(hideBelow),
    stickyOf(sticky, density),
    style
  );
  const shared = {
    "data-slot": "table-cell",
    colSpan,
    title: truncate ? title : undefined,
  };
  return rowHeader ? (
    <th scope="row" {...shared} {...look}>
      {children}
    </th>
  ) : (
    <td {...shared} {...look}>
      {children}
    </td>
  );
};
