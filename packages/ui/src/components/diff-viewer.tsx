// DiffViewer: what changed, before and after. For text and code, unified or side by side, with line
// numbers, added and removed lines tinted and marked at their start (a plus or a minus, and the
// words Added or Removed for a screen reader, never the colour alone), the words that changed
// within a line marked a step deeper, and long unchanged stretches folded behind "Show 24 unchanged
// lines". For prose, the change in the flow of the text. Accept and Reject per change, when it is
// a review. DiffViewerFiles draws several files, each under a header that folds it.
//
// Learned from GitHub's and GitLab's diffs (the two gutters, the folded runs, the words marked
// within a line, the file list with its counts and a big file folded), editors' review of an
// agent's edit (Accept and Reject per change, the change kept readable once decided) and document
// suggestions (prose changed in place).
//
//   <DiffViewer title="invoice.ts" oldValue={old} newValue={next} />
//   <DiffViewer mode="split" oldValue={old} newValue={next} />
//   <DiffViewer mode="inline" oldValue={draft} newValue={edited} />            prose
//   <DiffViewer oldValue={old} newValue={next} review onDecisionChange={(change, decision) => …} />
//   <DiffViewerFiles files={[{ path: "src/routes/index.tsx", oldValue, newValue }]} />
//
// On its own line diff (diff-viewer-diff.ts). A long diff draws only the lines in view, on UI SDK's
// virtualiser. No highlighting: plain text, so it reads the same for every language. Line numbers
// are never selected. Every value is a token; a caller sets layout only (`style`).
"use client";
// The rows are a grid table of divs, not <table>: a long diff places each row absolutely in its
// scroller, which table elements cannot do, so the table's roles are written out.

import * as stylex from "@stylexjs/stylex";
import { createVirtualizer } from "@ui-sdk/core";
import { CollapsiblePanel } from "@ui-sdk/react/collapsible";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import type { I18nCatalog } from "../lib/i18n";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronsUpDownIcon,
  Icon,
  MinusIcon,
  PlusIcon,
  UndoIcon,
  XIcon,
} from "../lib/icons";
import {
  fadeIn,
  focusRingInset,
  scrollbarHidden,
  visuallyHidden,
} from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "../lib/tokens.stylex";
import { announce } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, motionVars, ringInsetMarker } from "../lib/vars.stylex";
import { Badge } from "./badge";
import { Button } from "./button";
import { Collapsible, CollapsibleTrigger } from "./collapsible";
import {
  compare,
  foldsOf,
  highestNumber,
  hunkHead,
  longestLine,
  prose,
  splitRows,
  unifiedRows,
} from "./diff-viewer-diff";
import type { Change, Line, Row, SplitRow } from "./diff-viewer-diff";

/** What became of one change in a review. */
export type DiffViewerDecision = "accepted" | "rejected";

type DiffWords = I18nCatalog["diffViewer"];

/** Every prop a DiffViewer takes. */
export interface DiffViewerProps {
  /** The text as it was. */
  oldValue: string;
  /** The text as it is now. */
  newValue: string;
  /**
   * `unified`: one column, removed lines over the added ones. `split`: before on the left, after
   * on the right, for a wide screen. `inline`: prose, changed in the flow of its words.
   * @default "unified"
   */
  mode?: "unified" | "split" | "inline";
  /**
   * In `split`, the narrowest width (px) it is drawn side by side. Narrower, two columns of code
   * would each wrap to a few words, so it is drawn unified. 0 keeps it split at any width.
   * @default 640
   */
  splitMinWidth?: number;
  /** What changed: a file's name ("invoice.ts") or the document's. It names the diff. */
  title?: string;
  /**
   * The line over the diff with its title and the count of lines added and removed. Leave it on
   * unless something beside the diff already says them.
   * @default true
   */
  showHeader?: boolean;
  /**
   * Its name for a screen reader when there is no `title`.
   * @default the I18nProvider's `diffViewer.name` ("Changes")
   */
  "aria-label"?: string;
  /**
   * Unchanged lines kept round each change before the rest fold away.
   * @default 3
   */
  contextLines?: number;
  /**
   * Accept and Reject on each change, for a person reviewing an edit.
   * @default false
   */
  review?: boolean;
  /**
   * A hunk's header, `@@ -12,7 +12,8 @@` as git writes it, before each run of shown lines, for code
   * read by people who know patches. Unified only.
   * @default false
   */
  showHunkHeaders?: boolean;
  /**
   * Long lines wrap under their own start. False keeps each line whole, and the lines scroll
   * sideways inside the diff, never the page: for code, where a wrapped line misleads.
   * @default true
   */
  wrap?: boolean;
  /** What was decided on each change, by its number from 0, when you keep it. */
  decisions?: Readonly<Record<number, DiffViewerDecision>>;
  /** Called when a change is accepted, rejected, or put back to undecided (`null`). */
  onDecisionChange?: (
    change: number,
    decision: DiffViewerDecision | null
  ) => void;
  /**
   * Past this many rows it draws only the lines in view, and stands at most `diff-viewer-height`
   * tall.
   * @default 400
   */
  virtualizeThreshold?: number;
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

/**
 * One file's change, as whole texts, no patch: the part works out the lines and the counts. A file
 * with no `oldValue` is new; one with no `newValue` is deleted.
 */
export interface DiffViewerFile {
  /** Its path, shown in its header: the folder quiet, the file's name strong. */
  path: string;
  /** The file as it was. Left out, the file is new. */
  oldValue?: string;
  /** The file as it is now. Left out, the file is deleted. */
  newValue?: string;
}

/** Every prop a DiffViewerFiles takes. */
export interface DiffViewerFilesProps {
  /** The files that change, in the order they are shown. */
  files: readonly DiffViewerFile[];
  /**
   * The line on top: how many files changed, and the lines added and removed in all. Leave it on
   * unless the page already says them.
   * @default true
   */
  total?: boolean;
  /**
   * A file with more changed lines than this opens folded, so a big file does not bury the rest.
   * Its header still opens it.
   * @default 400
   */
  foldFrom?: number;
  /**
   * Unchanged lines kept round each change before the rest fold away.
   * @default 3
   */
  contextLines?: number;
  /**
   * A hunk's header, `@@ -12,7 +12,8 @@` as git writes it, before each run of a file's lines.
   * @default true
   */
  showHunkHeaders?: boolean;
  /**
   * Long lines wrap under their own start. False keeps each line whole, the lines scrolling
   * sideways inside the file under its pinned numbers.
   * @default false
   */
  wrap?: boolean;
  /**
   * Its name for a screen reader.
   * @default the I18nProvider's `diffViewer.filesName` ("Changed files")
   */
  "aria-label"?: string;
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

const FORCED = media.forcedColors;
const COARSE = media.pointerCoarse;
const HOVER = media.hover;
const BOX_CORNER = `min(${radius.base}, ${space["4"]})`;

const styles = stylex.create({
  diff: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    width: "100%",
    minWidth: 0,
    overflow: "hidden",
    borderRadius: BOX_CORNER,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: size.borderStrong,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    color: colors.foreground,
    fontFamily: font.sans,
  },
  // Drawn inside a box another part draws (a file of DiffViewerFiles): the lines alone.
  bare: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    width: "100%",
    minWidth: 0,
    color: colors.foreground,
    fontFamily: font.sans,
  },
  header: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["3"],
    paddingBlock: space["2"],
    paddingInline: space["4"],
    borderBlockEndWidth: size.separatorWidth,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  title: {
    minWidth: 0,
    fontFamily: font.mono,
    fontWeight: font.weightMedium,
    overflowWrap: "anywhere",
  },
  counts: {
    display: "flex",
    gap: space["2"],
    marginInlineStart: "auto",
    fontVariantNumeric: "tabular-nums",
  },
  plus: { color: colors.success, fontWeight: font.weightMedium },
  minus: { color: colors.destructive, fontWeight: font.weightMedium },
  body: { minWidth: 0 },
  // A long diff scrolls inside its own box, drawing only what is in view.
  scroll: {
    maxHeight: size.diffViewerHeight,
    overflowY: "auto",
    overscrollBehavior: "auto",
  },
  room: (height: number) => ({ position: "relative", height }),
  placed: (start: number) => ({
    position: "absolute",
    insetInline: 0,
    top: 0,
    transform: `translateY(${start}px)`,
  }),
  table: { display: "grid", minWidth: 0 },
  // Lines kept whole: the rows scroll sideways inside the diff, all as wide as the longest.
  sideways: { overflowX: "auto", overscrollBehaviorX: "auto" },
  // Its ch is the rows' (the mono face at text-sm), so the width set in ch fits the longest line.
  wide: (width: string) => ({
    minWidth: width,
    fontFamily: font.mono,
    fontSize: font.textSm,
  }),
  codeWhole: { whiteSpace: "pre", overflowWrap: "normal" },
  // A fold's and a hunk's words stay in view while the lines scroll sideways under them.
  stays: {
    position: "sticky",
    insetInlineStart: space["4"],
    display: "inline-flex",
    alignItems: "center",
    gap: space["2"],
  },
  // A hunk's header: where the lines after it stand in both texts, quiet, on the folds' band. The
  // control that opens the run folded before it stands in its gutter, the @@ where the words start.
  hunkRow: {
    alignItems: "center",
    backgroundColor: colors.diffViewerFoldBg,
  },
  hunkGutter: {
    gridColumn: "1 / span 3",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "stretch",
    minHeight: `calc(${font.textSmLine} + 2 * ${space["1"]})`,
  },
  hunk: {
    display: "flex",
    alignItems: "center",
    minWidth: 0,
    paddingBlock: space["1"],
    color: colors.mutedForeground,
    whiteSpace: "pre",
  },
  hunkWords: { position: "sticky" },
  // A line: its numbers, its mark, its words. Long lines wrap; nothing is cut off.
  row: {
    display: "grid",
    alignItems: "start",
    fontFamily: font.mono,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  // The number columns fit the file's longest number, never narrower than diff-viewer-number.
  unified: (number: string) => ({
    gridTemplateColumns: `${number} ${number} ${space["6"]} minmax(0, 1fr)`,
  }),
  split: { gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" },
  half: (number: string) => ({
    display: "grid",
    gridTemplateColumns: `${number} ${space["6"]} minmax(0, 1fr)`,
    minWidth: 0,
    alignSelf: "stretch",
  }),
  halfAfter: {
    borderInlineStartWidth: size.separatorWidth,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: colors.border,
  },
  added: { backgroundColor: colors.diffViewerAddedBg },
  removed: { backgroundColor: colors.diffViewerRemovedBg },
  // Lines kept whole: the numbers and the mark stay at the start (the right, right to left) while
  // the words scroll under them, on the box's ground with the row's tint laid over it.
  pinned: {
    position: "sticky",
    zIndex: 1,
    alignSelf: "stretch",
    backgroundColor: colors.card,
  },
  pinnedAdded: {
    backgroundImage: `linear-gradient(${colors.diffViewerAddedBg}, ${colors.diffViewerAddedBg})`,
  },
  pinnedRemoved: {
    backgroundImage: `linear-gradient(${colors.diffViewerRemovedBg}, ${colors.diffViewerRemovedBg})`,
  },
  pinnedFold: {
    backgroundImage: `linear-gradient(${colors.diffViewerFoldBg}, ${colors.diffViewerFoldBg})`,
  },
  pinStart: { insetInlineStart: 0 },
  pinAt: (offset: string) => ({ insetInlineStart: offset }),
  // An empty side, where a line was only added or only removed.
  blank: { backgroundColor: colors.diffViewerFoldBg },
  number: {
    paddingInline: space["2"],
    color: colors.mutedForeground,
    textAlign: "end",
    fontVariantNumeric: "tabular-nums",
    userSelect: "none",
  },
  mark: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: font.textSmLine,
    userSelect: "none",
  },
  markAdded: { color: colors.success },
  markRemoved: { color: colors.destructive },
  code: {
    minWidth: 0,
    paddingInlineEnd: space["3"],
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    tabSize: 2,
  },
  // A wrapped line hangs: its next lines start past its own indent, so they read as one line going
  // on, not a new one. Never more than half the cell, so a deep line still has room at 390.
  hang: (columns: number) => ({
    paddingInlineStart: `min(${columns}ch, 50%)`,
    textIndent: `calc(-1 * min(${columns}ch, 50%))`,
  }),
  whole: { whiteSpace: "nowrap" },
  // Underlined as well as tinted, so a changed word is never told by colour alone.
  wordAdded: {
    backgroundColor: colors.diffViewerAddedWord,
    borderRadius: radius.mark,
    cornerShape: radius.shape,
    textDecoration: "underline",
    textDecorationColor: colors.success,
    textUnderlineOffset: space["1"],
  },
  wordRemoved: {
    backgroundColor: colors.diffViewerRemovedWord,
    borderRadius: radius.mark,
    cornerShape: radius.shape,
    textDecoration: "line-through",
    textDecorationColor: colors.destructive,
  },
  // The last row's fold follows the box's rounded foot, so its focus ring (drawn inside it) is not
  // cut by the box's corners.
  foldLast: {
    borderEndStartRadius: BOX_CORNER,
    borderEndEndRadius: BOX_CORNER,
  },
  // The fold's ring stands a ring's width in from its edges: drawn on them it lay on the box's own
  // border, a second square border inside a rounded box. Last, it follows the rounded foot.
  foldRing: { outlineOffset: `calc(-2 * ${size.ringWidth})` },
  // A folded run of unchanged lines: the whole row is its button.
  fold: {
    [iconVars.size]: size.iconSm,
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    width: "100%",
    // A finger needs 44px; a pointer, the row's own height.
    minHeight: { default: null, [COARSE]: size.tapTarget },
    margin: 0,
    paddingBlock: space["1"],
    paddingInline: space["4"],
    // Its band is a fill, which forced colours drop: a line above and below marks it there.
    borderWidth: 0,
    borderBlockWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    // Hover lays a row's own hover over the band.
    backgroundColor: colors.diffViewerFoldBg,
    backgroundImage: {
      default: null,
      ":hover": {
        default: null,
        [HOVER]: `linear-gradient(${colors.accent}, ${colors.accent})`,
      },
    },
    // Ink on the hover fill, as a quiet button's words: muted on it fell to 4.4:1 in dark.
    color: {
      default: colors.mutedForeground,
      ":hover": { default: colors.mutedForeground, [HOVER]: colors.foreground },
    },
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    textAlign: "start",
    cursor: "pointer",
  },
  // A change's header in a review: which change, and its answers.
  changeHead: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
    paddingBlock: space["1"],
    paddingInline: space["3"],
    backgroundColor: colors.diffViewerFoldBg,
    borderBlockStartWidth: size.separatorWidth,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  changeName: { color: colors.mutedForeground, minWidth: 0 },
  // The answers, at the end of the header. They and the result they give way to stand in one cell,
  // so the header keeps its width and height whatever is decided, and nothing beside it moves.
  changeEnd: {
    display: "grid",
    justifyItems: "end",
    alignItems: "center",
    marginInlineStart: "auto",
  },
  layer: {
    gridArea: "1 / 1",
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    // Coming in it is visible at once, so it can take focus, and fades up.
    transitionProperty: "opacity",
    transitionDuration: motionVars.swap,
    transitionTimingFunction: duration.ease,
  },
  // The layer not in use: out of sight, out of the keys' reach and unsaid, once it has faded.
  away: {
    opacity: 0,
    visibility: "hidden",
    transitionProperty: "opacity, visibility",
  },
  // Accepted and Rejected share one place, where Accept stood, so the result never changes width.
  results: { display: "grid", justifyItems: "end", alignItems: "center" },
  // As tall as the button it replaced, its words where the button's were, on the soft ground of
  // what was decided, so the answer reads at a glance down a long review.
  result: {
    gridArea: "1 / 1",
    display: "inline-flex",
    alignItems: "center",
    gap: space["1"],
    minHeight: size.controlSm,
    paddingInline: space["3"],
    borderRadius: `calc(${size.controlSm} / 2)`,
    cornerShape: radius.shape,
    color: colors.foreground,
    fontWeight: font.weightMedium,
    transitionProperty: "opacity",
    transitionDuration: motionVars.swap,
    transitionTimingFunction: duration.ease,
  },
  resultKept: { backgroundColor: colors.successSubtle },
  resultTurnedDown: { backgroundColor: colors.destructiveSubtle },
  resultAway: {
    opacity: 0,
    visibility: "hidden",
    transitionProperty: "opacity, visibility",
  },
  // The result arrives as a Button's does: the mark first, then its word beside it. It leaves
  // faster, all at once.
  resultMark: {
    display: "inline-flex",
    transitionProperty: "opacity, transform",
    transitionDuration: motionVars.mark,
    transitionTimingFunction: duration.ease,
  },
  resultMarkAway: {
    opacity: 0,
    transform: {
      default: `scale(${size.resultMarkFrom})`,
      [media.reducedMotion]: "none",
    },
    transitionDuration: motionVars.swap,
  },
  kept: { color: colors.success },
  turnedDown: { color: colors.destructive },
  resultWord: {
    transitionProperty: "opacity, transform",
    transitionDuration: motionVars.swap,
    transitionDelay: motionVars.follow,
    transitionTimingFunction: duration.ease,
  },
  resultWordAway: {
    opacity: 0,
    transform: {
      default: `translateX(calc(-1 * ${size.resultShift}))`,
      [media.reducedMotion]: "none",
    },
    transitionDelay: "0s",
  },
  // The side a decision leaves behind stands back, still readable: the removed lines of an
  // accepted change, the added lines of a rejected one.
  settles: {
    transitionProperty: "opacity",
    transitionDuration: motionVars.mark,
    transitionTimingFunction: duration.ease,
  },
  settled: { opacity: size.opacityDisabled },
  // Prose: the change in the flow of the words.
  prose: {
    margin: 0,
    paddingBlock: space["4"],
    paddingInline: space["5"],
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  ins: {
    backgroundColor: colors.diffViewerAddedWord,
    textDecoration: "underline",
    textDecorationColor: colors.success,
    textUnderlineOffset: space["1"],
    borderRadius: radius.mark,
    cornerShape: radius.shape,
  },
  del: {
    backgroundColor: colors.diffViewerRemovedWord,
    textDecoration: "line-through",
    textDecorationColor: colors.destructive,
    borderRadius: radius.mark,
    cornerShape: radius.shape,
  },
  empty: {
    paddingBlock: space["4"],
    paddingInline: space["4"],
    color: colors.mutedForeground,
    fontSize: font.textSm,
  },

  // ---- DiffViewerFiles ----
  list: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: space["3"],
    width: "100%",
    minWidth: 0,
    color: colors.foreground,
    fontFamily: font.sans,
  },
  // The line on top: the files changed, then the lines added and removed.
  total: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: space["3"],
    margin: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
  },
  // One file: its header and its lines in one box.
  file: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    minWidth: 0,
    overflow: "hidden",
    borderRadius: BOX_CORNER,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: size.borderStrong,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
  },
  // The file's header: the whole row is the button that folds it.
  fileHeader: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    width: "100%",
    minWidth: 0,
    minHeight: { default: null, [COARSE]: size.tapTarget },
    margin: 0,
    paddingBlock: space["2"],
    paddingInline: space["3"],
    borderWidth: 0,
    backgroundColor: "transparent",
    backgroundImage: {
      default: null,
      ":hover": {
        default: null,
        [HOVER]: `linear-gradient(${colors.accent}, ${colors.accent})`,
      },
    },
    color: colors.foreground,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    textAlign: "start",
    cursor: "pointer",
  },
  // Open, a line under the header parts it from the lines.
  fileHeaderOpen: {
    borderBlockEndWidth: size.separatorWidth,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
  },
  // The header's ring stands inside the box, so the box's corners do not cut it.
  fileRing: { outlineOffset: `calc(-2 * ${size.ringWidth})` },
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    color: colors.mutedForeground,
    transitionProperty: "transform",
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
    transform: "rotate(-0.25turn)",
  },
  chevronOpen: { transform: "none" },
  // The path: the folder quiet and cut from its start, the file's name strong and whole.
  path: {
    display: "flex",
    minWidth: 0,
    flex: "1 1 auto",
    fontFamily: font.mono,
  },
  // A path reads left to right in every language; laid right to left, its overflow is cut at the
  // start, so the end of the folder (the part beside the name) stays.
  folder: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    direction: "rtl",
    color: colors.mutedForeground,
  },
  name: {
    flexShrink: 0,
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: font.weightMedium,
  },
  // The badge keeps its word whole: the path gives way, never the badge.
  badge: { display: "inline-flex", flexShrink: 0, whiteSpace: "nowrap" },
  fileCounts: {
    display: "flex",
    flexShrink: 0,
    gap: space["2"],
    fontVariantNumeric: "tabular-nums",
  },
  filesEmpty: {
    margin: 0,
    color: colors.mutedForeground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
});

const NO_ITEMS: never[] = [];
/** A row's first guess at its height: one line of text-sm-line. */
const ROW_GUESS = 20;
/** The rows a long diff draws before the browser has measured any: about its box's height. */
const FIRST_ROWS = 40;

type AnyRow = Row | SplitRow;

// Where a long line may wrap. Code has few spaces, so a line like "due.setDate(due.getDate()" was
// one unbreakable run: it dropped whole below its number and sign, or broke mid-word anywhere. It
// may also break after these marks, as a path or a call reads (not inside an empty "()");
// anywhere is the last resort.
const BREAK_AFTER = /(?<mark>[/.,=&|]|\((?!\)))/u;
// An option ("-r", "--force") is one word: never "read -" on one line and "r link" on the next.
const OPTION = /(?<option>(?:^|(?<=\s))--?[A-Za-z][\w-]{0,30})/u;

/** Text with its break points marked, and its options kept whole. */
const breakable = (text: string, at: string): ReactNode[] =>
  text.split(OPTION).flatMap((part, index) => {
    if (index % 2 === 1) {
      return [
        <span key={`${at}o${index}`} {...stylex.props(styles.whole)}>
          {part}
        </span>,
      ];
    }
    return part.split(BREAK_AFTER).flatMap((bit, place) => {
      if (place % 2 === 1) {
        return [bit, <wbr key={`${at}w${index}.${place}`} />];
      }
      return bit === "" ? [] : [bit];
    });
  });

/** A line's columns of indent: a tab is two, as the code shows it. */
const indentOf = (text: string) => {
  let columns = 0;
  for (const character of text) {
    if (character === " ") {
      columns += 1;
    } else if (character === "\t") {
      columns += 2;
    } else {
      break;
    }
  }
  return columns;
};

/** A line's words, with the words that changed within it marked. */
const LineText = ({ line }: { line?: Line }) => {
  if (line === undefined) {
    return null;
  }
  if (line.pieces === undefined) {
    return line.text === "" ? " " : breakable(line.text, "t");
  }
  const look = line.kind === "added" ? styles.wordAdded : styles.wordRemoved;
  return (
    <>
      {line.pieces.map((piece, index) =>
        piece.changed ? (
          // A piece has no id; its place in the line is its key, and pieces never reorder.
          <span key={index} {...stylex.props(look)}>
            {breakable(piece.text, `p${index}`)}
          </span>
        ) : (
          breakable(piece.text, `p${index}`)
        )
      )}
    </>
  );
};

/** The code cell: its line hangs, so a wrapped line goes on under its own start, past the gutter. */
const Code = ({
  line,
  cell,
  wrap,
}: {
  line?: Line;
  cell: boolean;
  wrap: boolean;
}) => (
  <span
    role={cell ? "cell" : undefined}
    data-diff-code=""
    {...stylex.props(
      styles.code,
      wrap ? styles.hang(indentOf(line?.text ?? "") + 2) : styles.codeWhole
    )}
  >
    <LineText line={line} />
  </span>
);

/** The mark at a line's start, said in words too. */
const Mark = ({
  kind,
  cell = true,
  words,
  look,
}: {
  kind: Line["kind"];
  cell?: boolean;
  words: DiffWords;
  look?: stylex.StyleXStyles;
}) => {
  const role = cell ? "cell" : undefined;
  if (kind === "same") {
    return <span role={role} {...stylex.props(styles.mark, look)} />;
  }
  const added = kind === "added";
  return (
    <span
      role={role}
      {...stylex.props(
        styles.mark,
        added ? styles.markAdded : styles.markRemoved,
        look
      )}
    >
      <Icon icon={added ? PlusIcon : MinusIcon} />
      <span {...stylex.props(visuallyHidden)}>
        {added ? words.added : words.removed}
      </span>
    </span>
  );
};

const tint = (line?: Line) => {
  if (line?.kind === "added") {
    return styles.added;
  }
  return line?.kind === "removed" ? styles.removed : false;
};

/** A pinned cell's tint, laid over the box's ground. */
const pinnedTint = (line: Line) => {
  if (line.kind === "added") {
    return styles.pinnedAdded;
  }
  return line.kind === "removed" ? styles.pinnedRemoved : null;
};

/** Whether a decision left this line behind: the removed lines of an accepted change, the added of a rejected. */
const leftBehind = (
  line: Line | undefined,
  decisions: Readonly<Record<number, DiffViewerDecision>>
) => {
  if (line?.change === undefined) {
    return false;
  }
  const decided = decisions[line.change];
  return (
    (decided === "accepted" && line.kind === "removed") ||
    (decided === "rejected" && line.kind === "added")
  );
};

/** What every row is drawn with. */
interface Drawing {
  split: boolean;
  /** Long lines wrap; else they stay whole and the rows scroll sideways. */
  wrap: boolean;
  /** The width of a number column. */
  number: string;
  /** The diff's id, for naming a change. */
  name: string;
  total: number;
  words: DiffWords;
  decisions: Readonly<Record<number, DiffViewerDecision>>;
  /** The lines a fold just let out: they fade in. */
  fresh: ReadonlySet<string>;
  onUnfold: (
    row: { key: string; from: number; count: number },
    byKeys: boolean
  ) => void;
  onDecide: (
    change: Change,
    decision: DiffViewerDecision | null,
    byKeys: boolean
  ) => void;
}

/** A folded run of unchanged lines: the whole row is its button. */
const FoldRow = ({
  row,
  index,
  drawing,
  last,
}: {
  row: Extract<AnyRow, { type: "fold" }>;
  index: number;
  drawing: Drawing;
  last: boolean;
}) => (
  <div role="row" aria-rowindex={index + 2}>
    <span role="cell" aria-colspan={drawing.split ? 2 : 4}>
      {/* A click with no pointer detail is a press by keys. */}
      <button
        type="button"
        onClick={(event) => {
          drawing.onUnfold(row, event.detail === 0);
        }}
        {...stylex.props(
          styles.fold,
          last && styles.foldLast,
          focusRingInset,
          styles.foldRing
        )}
      >
        <span {...stylex.props(styles.stays)}>
          <Icon icon={ChevronDownIcon} />
          {drawing.words.unchanged(row.count)}
        </span>
      </button>
    </span>
  </div>
);

/** One result, in the place Accept stood: its mark, then its word. */
const Result = ({
  shown,
  kept,
  children,
}: {
  shown: boolean;
  kept: boolean;
  children: ReactNode;
}) => (
  <span
    data-diff-result={shown ? "" : undefined}
    {...stylex.props(
      styles.result,
      kept ? styles.resultKept : styles.resultTurnedDown,
      !shown && styles.resultAway
    )}
  >
    <span
      {...stylex.props(
        styles.resultMark,
        kept ? styles.kept : styles.turnedDown,
        !shown && styles.resultMarkAway
      )}
    >
      <Icon icon={kept ? CheckIcon : XIcon} />
    </span>
    <span {...stylex.props(styles.resultWord, !shown && styles.resultWordAway)}>
      {children}
    </span>
  </span>
);

/**
 * A change's header in a review: which change, and its answers. An answer is taken at once and can
 * be undone: Undo stands where Reject stood and the result where Accept stood, so the row is the
 * same row before and after.
 */
const HeadRow = ({
  row,
  index,
  drawing,
}: {
  row: Extract<AnyRow, { type: "head" }>;
  index: number;
  drawing: Drawing;
}) => {
  const { change } = row;
  const { words } = drawing;
  const decided = drawing.decisions[change.index];
  const settled = decided !== undefined;
  const described = `${drawing.name}-change-${change.index}`;
  return (
    <div role="row" aria-rowindex={index + 2}>
      <span
        role="cell"
        aria-colspan={drawing.split ? 2 : 4}
        data-diff-change={change.index}
        data-decided={decided}
        {...stylex.props(styles.changeHead)}
      >
        <span {...stylex.props(styles.changeName)}>
          <span id={described}>
            {words.changeOf(
              change.index + 1,
              drawing.total,
              change.removed,
              change.added
            )}
          </span>
        </span>
        <span {...stylex.props(styles.changeEnd)}>
          <span
            inert={settled}
            {...stylex.props(styles.layer, settled && styles.away)}
          >
            <Button
              size="sm"
              variant="ghost"
              aria-describedby={described}
              onClick={(event) => {
                drawing.onDecide(change, "rejected", event.detail === 0);
              }}
            >
              <Icon icon={XIcon} />
              {words.reject}
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-diff-answer="accept"
              aria-describedby={described}
              onClick={(event) => {
                drawing.onDecide(change, "accepted", event.detail === 0);
              }}
            >
              <Icon icon={CheckIcon} />
              {words.accept}
            </Button>
          </span>
          <span
            inert={!settled}
            {...stylex.props(styles.layer, !settled && styles.away)}
          >
            <Button
              size="sm"
              variant="ghost"
              data-diff-answer="undo"
              aria-describedby={described}
              onClick={(event) => {
                drawing.onDecide(change, null, event.detail === 0);
              }}
            >
              <Icon icon={UndoIcon} />
              {words.undo}
            </Button>
            <span {...stylex.props(styles.results)}>
              <Result shown={decided === "accepted"} kept>
                {words.accepted}
              </Result>
              <Result shown={decided === "rejected"} kept={false}>
                {words.rejected}
              </Result>
            </span>
          </span>
        </span>
      </span>
    </div>
  );
};

/** One line of the unified form: its two numbers, its mark, its words. */
const LineRow = ({
  row,
  index,
  drawing,
}: {
  row: Extract<Row, { type: "line" }>;
  index: number;
  drawing: Drawing;
}) => {
  const { line } = row;
  // With lines kept whole, the gutter stays where it is while the words scroll sideways.
  const pin = (offset: string | null) =>
    !drawing.wrap && [
      styles.pinned,
      pinnedTint(line),
      offset === null ? styles.pinStart : styles.pinAt(offset),
    ];
  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      {...stylex.props(
        styles.row,
        styles.unified(drawing.number),
        tint(line),
        styles.settles,
        leftBehind(line, drawing.decisions) && styles.settled,
        drawing.fresh.has(row.key) && fadeIn
      )}
    >
      <span role="cell" {...stylex.props(styles.number, pin(null))}>
        {line.oldNo ?? ""}
      </span>
      <span role="cell" {...stylex.props(styles.number, pin(drawing.number))}>
        {line.newNo ?? ""}
      </span>
      <Mark
        kind={line.kind}
        words={drawing.words}
        look={pin(`calc(2 * ${drawing.number})`)}
      />
      <Code line={line} cell wrap={drawing.wrap} />
    </div>
  );
};

/** One side of a side-by-side row. */
const Side = ({
  line,
  after,
  drawing,
}: {
  line: Line | undefined;
  after: boolean;
  drawing: Drawing;
}) => {
  const own = after ? line?.newNo : line?.oldNo;
  return (
    <span
      role="cell"
      {...stylex.props(
        styles.half(drawing.number),
        after && styles.halfAfter,
        line === undefined ? styles.blank : tint(line),
        styles.settles,
        leftBehind(line, drawing.decisions) && styles.settled
      )}
    >
      <span {...stylex.props(styles.number)}>{own ?? ""}</span>
      {line === undefined ? (
        <span />
      ) : (
        <Mark kind={line.kind} cell={false} words={drawing.words} />
      )}
      <Code line={line} cell={false} wrap={drawing.wrap} />
    </span>
  );
};

/** Side by side: before on the left, after on the right. */
const PairRow = ({
  row,
  index,
  drawing,
}: {
  row: Extract<SplitRow, { type: "pair" }>;
  index: number;
  drawing: Drawing;
}) => (
  <div
    role="row"
    aria-rowindex={index + 2}
    {...stylex.props(
      styles.row,
      styles.split,
      drawing.fresh.has(row.key) && fadeIn
    )}
  >
    <Side line={row.left} after={false} drawing={drawing} />
    <Side line={row.right} after drawing={drawing} />
  </div>
);

/**
 * A hunk's header: "@@ -12,7 +12,8 @@", said in words. When unchanged lines are folded just before
 * it, the control that opens them stands in its gutter, named "Show 10 unchanged lines" (its
 * tooltip too).
 */
const HunkRow = ({
  row,
  index,
  drawing,
}: {
  row: Extract<AnyRow, { type: "hunk" }>;
  index: number;
  drawing: Drawing;
}) => {
  const { fold } = row;
  const gutter = `calc(2 * ${drawing.number} + ${space["6"]})`;
  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      {...stylex.props(
        styles.row,
        styles.unified(drawing.number),
        styles.hunkRow
      )}
    >
      <span
        role="cell"
        aria-colspan={3}
        {...stylex.props(
          styles.hunkGutter,
          !drawing.wrap && [styles.pinned, styles.pinnedFold, styles.pinStart]
        )}
      >
        {fold === undefined ? null : (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={drawing.words.unchanged(fold.count)}
            data-diff-unfold=""
            onClick={(event) => {
              drawing.onUnfold(fold, event.detail === 0);
            }}
          >
            <Icon icon={ChevronsUpDownIcon} />
          </Button>
        )}
      </span>
      <span role="cell" data-diff-hunk="" {...stylex.props(styles.hunk)}>
        <span
          aria-hidden="true"
          {...stylex.props(
            styles.hunkWords,
            drawing.wrap ? styles.pinStart : styles.pinAt(gutter)
          )}
        >
          {hunkHead(row)}
        </span>
        <span {...stylex.props(visuallyHidden)}>
          {drawing.words.hunk(
            row.oldStart,
            row.oldCount,
            row.newStart,
            row.newCount
          )}
        </span>
      </span>
    </div>
  );
};

const DrawnRow = ({
  row,
  index,
  drawing,
  last = false,
}: {
  row: AnyRow;
  index: number;
  drawing: Drawing;
  last?: boolean;
}) => {
  if (row.type === "hunk") {
    return <HunkRow row={row} index={index} drawing={drawing} />;
  }
  if (row.type === "fold") {
    return <FoldRow row={row} index={index} drawing={drawing} last={last} />;
  }
  if (row.type === "head") {
    return <HeadRow row={row} index={index} drawing={drawing} />;
  }
  if (row.type === "line") {
    return <LineRow row={row} index={index} drawing={drawing} />;
  }
  return <PairRow row={row} index={index} drawing={drawing} />;
};

/**
 * The rows a long diff keeps: UI SDK's virtualiser, told the rows as they are now. Rows keep their
 * measured height by their own key, so opening a fold moves nothing onto the wrong row. A row's
 * first guess is one line of text-sm-line, 20px.
 */
const makeWindow = () => {
  let rows: readonly AnyRow[] = [];
  let kept: readonly number[] = NO_ITEMS;
  // Before the browser measures anything (the first HTML, and with JavaScript off), the top of the
  // diff is there: its first rows at their first guess, one line each.
  let firstFor: readonly AnyRow[] | null = null;
  let firstItems: {
    index: number;
    key: string;
    start: number;
    size: number;
  }[] = [];
  const virtual = createVirtualizer({
    count: () => rows.length,
    key: (index) => rows[index]?.key ?? String(index),
    estimate: () => ROW_GUESS,
    overscan: 12,
    // The row holding focus stays drawn when it scrolls away, so focus is never lost.
    keep: () => kept,
  });
  return {
    virtual,
    show: (next: readonly AnyRow[]) => {
      rows = next;
      virtual.refresh();
    },
    keep: (index: number) => {
      kept = [index];
    },
    first: (all: readonly AnyRow[]) => {
      if (firstFor !== all) {
        firstFor = all;
        firstItems = all.slice(0, FIRST_ROWS).map((row, index) => ({
          index,
          key: row.key,
          start: index * ROW_GUESS,
          size: ROW_GUESS,
        }));
      }
      return firstItems;
    },
  };
};

/** A long diff: only the rows in view and a few round them are drawn. */
const VirtualRows = ({
  rows,
  scroller,
  drawing,
}: {
  rows: readonly AnyRow[];
  scroller: HTMLElement | null;
  drawing: Drawing;
}) => {
  // oxlint-disable-next-line react/hook-use-state -- made once, never set
  const [win] = useState(makeWindow);
  useLayoutEffect(() => {
    win.show(rows);
  }, [rows, win]);
  useEffect(
    () => (scroller === null ? undefined : win.virtual.connect(scroller)),
    [scroller, win]
  );
  const subscribe = (change: () => void) => win.virtual.subscribe(change);
  const items = useSyncExternalStore(
    subscribe,
    () => win.virtual.items(),
    () => win.first(rows)
  );
  const height = useSyncExternalStore(
    subscribe,
    () => win.virtual.size(),
    () => rows.length * ROW_GUESS
  );
  return (
    <div {...stylex.props(styles.room(height))}>
      {items.map((item) => {
        const row = rows[item.index];
        if (row === undefined) {
          return null;
        }
        return (
          <div
            key={row.key}
            ref={(element) => {
              if (element !== null) {
                win.virtual.measure(item.index, element);
              }
            }}
            onFocus={() => {
              win.keep(item.index);
            }}
            {...stylex.props(styles.placed(item.start))}
          >
            <DrawnRow row={row} index={item.index} drawing={drawing} />
          </div>
        );
      })}
    </div>
  );
};

/** `+7 −5`, each said in words with the counts, never the colour alone. */
const Counts = ({
  added,
  removed,
  said,
  look,
  skipZero = false,
}: {
  added: number;
  removed: number;
  said: string;
  look: stylex.StyleXStyles;
  /** A side that is 0 left out ("+15" for a new file). */
  skipZero?: boolean;
}) => (
  <span {...stylex.props(look)}>
    {skipZero && added === 0 ? null : (
      <span aria-hidden="true" {...stylex.props(styles.plus)}>
        +{added}
      </span>
    )}
    {skipZero && removed === 0 ? null : (
      <span aria-hidden="true" {...stylex.props(styles.minus)}>
        −{removed}
      </span>
    )}
    <span {...stylex.props(visuallyHidden)}>{said}</span>
  </span>
);

/** The line over the diff: its title and how many lines were added and removed. */
const Header = ({
  id,
  title,
  added,
  removed,
  words,
}: {
  id: string;
  title?: string;
  added: number;
  removed: number;
  words: DiffWords;
}) => (
  <div {...stylex.props(styles.header)}>
    {title !== undefined && title !== "" && (
      <span id={id} {...stylex.props(styles.title)}>
        {title}
      </span>
    )}
    <Counts
      added={added}
      removed={removed}
      said={words.counts(added, removed)}
      look={styles.counts}
    />
  </div>
);

/** Prose: the change in the flow of the words. */
const Prose = ({
  oldValue,
  newValue,
  words,
}: {
  oldValue: string;
  newValue: string;
  words: DiffWords;
}) => (
  <p {...stylex.props(styles.prose)}>
    {prose(oldValue, newValue).map((piece, index) => {
      if (piece.kind === "same") {
        return piece.text;
      }
      const Tag = piece.kind === "added" ? "ins" : "del";
      return (
        // A piece has no id; its place in the text is its key, and pieces never reorder.
        <Tag
          key={index}
          {...stylex.props(piece.kind === "added" ? styles.ins : styles.del)}
        >
          <span {...stylex.props(visuallyHidden)}>
            {piece.kind === "added" ? words.added : words.removed}:{" "}
          </span>
          {piece.text}
        </Tag>
      );
    })}
  </p>
);

/** The columns' names, for a screen reader. */
const Columns = ({ split, words }: { split: boolean; words: DiffWords }) => (
  <div role="row" aria-rowindex={1} {...stylex.props(visuallyHidden)}>
    {(split
      ? [words.before, words.after]
      : [words.lineBefore, words.lineAfter, words.change, words.text]
    ).map((name) => (
      <span key={name} role="columnheader">
        {name}
      </span>
    ))}
  </div>
);

const NO_FOLDS: ReadonlyMap<string, number> = new Map();
const NO_DECISIONS: Readonly<Record<number, DiffViewerDecision>> = {};
const NO_FRESH: ReadonlySet<string> = new Set();

/** Where focus goes after a press by keys took its button away. */
type Target = { change: number; to: "undo" | "accept" } | { change: null };

const modelOf = (oldValue: string, newValue: string) => ({
  oldValue,
  newValue,
  ...compare(oldValue, newValue),
});

/** The lines and changes of two texts, and what the person did with them: folds let out, decisions. */
const useModel = (oldValue: string, newValue: string) => {
  // Worked out once per pair of texts.
  const [model, setModel] = useState(() => modelOf(oldValue, newValue));
  // The folds let out, by their key, with how many lines each held.
  const [open, setOpen] = useState(NO_FOLDS);
  // The lines the last fold let out: they fade in.
  const [fresh, setFresh] = useState(NO_FRESH);
  const [own, setOwn] = useState(NO_DECISIONS);
  // Folds and decisions belong to these two texts: new texts start afresh.
  if (model.oldValue !== oldValue || model.newValue !== newValue) {
    setModel(modelOf(oldValue, newValue));
    setOpen(NO_FOLDS);
    setFresh(NO_FRESH);
    setOwn(NO_DECISIONS);
  }
  return { model, open, setOpen, fresh, setFresh, own, setOwn };
};

/** After a press by keys took its button away, focus goes to what replaced it, so the keys carry on. */
const useFocusAfter = (body: HTMLDivElement | null) => {
  const [target, setTarget] = useState<Target | null>(null);
  useEffect(() => {
    if (target === null || body === null) {
      return;
    }
    if (target.change === null) {
      body.focus({ preventScroll: true });
      return;
    }
    body
      .querySelector<HTMLElement>(
        `[data-diff-change="${target.change}"] [data-diff-answer="${target.to}"]`
      )
      ?.focus();
  }, [target, body]);
  return setTarget;
};

const countOf = (lines: readonly Line[], kind: Line["kind"]) =>
  lines.filter((line) => line.kind === kind).length;

/** The table of rows: every row, or in a long diff only those in view. */
const Table = ({
  rows,
  said,
  virtual,
  scroller,
  drawing,
  width,
}: {
  rows: readonly AnyRow[];
  said: string;
  virtual: boolean;
  scroller: HTMLElement | null;
  drawing: Drawing;
  /** With lines kept whole, as wide as the longest line and its gutter. */
  width: string | undefined;
}) => (
  <div
    role="table"
    aria-label={said}
    aria-rowcount={rows.length + 1}
    {...stylex.props(styles.table, width !== undefined && styles.wide(width))}
  >
    <Columns split={drawing.split} words={drawing.words} />
    {virtual ? (
      <VirtualRows rows={rows} scroller={scroller} drawing={drawing} />
    ) : (
      rows.map((row, index) => (
        <DrawnRow
          key={row.key}
          row={row}
          index={index}
          drawing={drawing}
          last={index === rows.length - 1}
        />
      ))
    )}
  </div>
);

/** Every prop of DiffViewer, with its defaults filled and its words whole. */
interface Settled {
  oldValue: string;
  newValue: string;
  mode: "unified" | "split" | "inline";
  splitMinWidth: number;
  title: string | undefined;
  showHeader: boolean;
  label: string | undefined;
  contextLines: number;
  review: boolean;
  showHunkHeaders: boolean;
  wrap: boolean;
  decisions: Readonly<Record<number, DiffViewerDecision>> | undefined;
  onDecisionChange: DiffViewerProps["onDecisionChange"];
  virtualizeThreshold: number;
  style: LayoutStyle | undefined;
  words: DiffWords;
  /** In its own box (DiffViewer), or bare inside a file of DiffViewerFiles. */
  framed: boolean;
}

/** Says whether the diff is at least `from` px wide, now and on each resize. */
const watchWidth = (
  element: HTMLElement,
  from: number,
  setWide: (wide: boolean) => void
) => {
  const measure = () => {
    setWide(element.clientWidth >= from);
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  return () => {
    observer.disconnect();
  };
};

/** Whether a split diff is drawn side by side: only while the element given to setRoot is at least `from` px wide. */
const useSplit = (mode: Settled["mode"], from: number) => {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [wide, setWide] = useState(true);
  useEffect(
    () => (root === null ? undefined : watchWidth(root, from, setWide)),
    [root, from]
  );
  const split = mode === "split" && wide;
  return { setRoot, split, drawn: split ? "split" : "unified" };
};

/**
 * With lines kept whole, how wide the rows stand: the longest line (in the mono face a character is
 * a ch, a tab two) and the gutter before it, so every row's tint runs the whole way as they scroll.
 */
const wholeWidth = (lines: readonly Line[], number: string, split: boolean) => {
  // One ch more than the longest line: a ch is fractional, and a line that only just fits would
  // break at its last break point.
  const longest = longestLine(lines) + 1;
  if (split) {
    return `calc(2 * (${number} + ${space["6"]} + ${longest}ch + ${space["3"]}))`;
  }
  return `calc(2 * ${number} + ${space["6"]} + ${longest}ch + ${space["3"]})`;
};

/**
 * The rows' box. One that scrolls (a long diff, downwards; lines kept whole, sideways) takes focus
 * and is a named region, so the keys can scroll it.
 */
const Body = ({
  setBody,
  virtual,
  wrap,
  name,
  children,
}: {
  setBody: (element: HTMLDivElement | null) => void;
  virtual: boolean;
  wrap: boolean;
  name: string;
  children: ReactNode;
}) => {
  const scrolls = virtual || !wrap;
  return (
    <div
      ref={setBody}
      tabIndex={scrolls ? 0 : -1}
      role={scrolls ? "region" : undefined}
      aria-label={scrolls ? name : undefined}
      {...stylex.props(
        styles.body,
        virtual && styles.scroll,
        !wrap && styles.sideways,
        scrolls && scrollbarHidden,
        focusRingInset
      )}
    >
      {children}
    </div>
  );
};

/** The diff by line: unified or side by side, with folds, and the answers when reviewing. */
const LineDiff = (props: Settled) => {
  const {
    oldValue,
    newValue,
    mode,
    splitMinWidth,
    title,
    showHeader,
    label,
    contextLines,
    review,
    showHunkHeaders,
    wrap,
    decisions: given,
    onDecisionChange,
    virtualizeThreshold,
    words,
    style,
    framed,
  } = props;
  // Side by side only where both sides have room; narrower, it falls back to unified.
  const { setRoot, split, drawn } = useSplit(mode, splitMinWidth);
  const { model, open, setOpen, fresh, setFresh, own, setOwn } = useModel(
    oldValue,
    newValue
  );
  const { lines, changes } = model;
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const setTarget = useFocusAfter(body);
  const name = useId();
  const named = title !== undefined && title !== "";
  const added = countOf(lines, "added");
  const removed = countOf(lines, "removed");
  const said = (named ? title : label) ?? words.name;

  const folds = foldsOf(lines, changes, contextLines, open);
  const rows: AnyRow[] = split
    ? splitRows(lines, changes, folds, review)
    : unifiedRows(lines, changes, folds, review, showHunkHeaders);
  const virtual = rows.length > virtualizeThreshold;

  // Wide enough for the longest number, with the column's room either side.
  const digits = String(highestNumber(lines)).length;
  const number = `max(${size.diffViewerNumber}, calc(${digits}ch + 2 * ${space["2"]}))`;
  const drawing: Drawing = {
    split,
    wrap,
    number,
    name,
    total: changes.length,
    words,
    decisions: given ?? own,
    // In a long diff a row is drawn again each time it scrolls into view: nothing fades there.
    fresh: virtual ? NO_FRESH : fresh,
    onUnfold: (row, byKeys) => {
      setOpen((was) => new Map([...was, [row.key, row.count]]));
      // The lines the fold held arrive: they fade in where the fold stood.
      const arrived = new Set<string>();
      for (let at = row.from; at < row.from + row.count; at += 1) {
        arrived.add(`line-${at}`).add(`pair-${at}`);
      }
      setFresh(arrived);
      // The button goes with the fold. After a press by keys focus stays in the diff, on its body; a
      // pointer's press leaves focus alone, so no ring is drawn round the whole diff.
      if (byKeys) {
        setTarget({ change: null });
      }
    },
    onDecide: (change, decision, byKeys) => {
      if (byKeys) {
        setTarget({
          change: change.index,
          to: decision === null ? "accept" : "undo",
        });
      }
      announce(words.said(change.index + 1, decision));
      if (given === undefined) {
        setOwn((was) => {
          const rest = Object.fromEntries(
            Object.entries(was).filter(([key]) => key !== String(change.index))
          );
          return decision === null
            ? rest
            : { ...rest, [change.index]: decision };
        });
      }
      onDecisionChange?.(change.index, decision);
    },
  };

  const empty = lines.length === 0 || (changes.length === 0 && open.size === 0);
  const width = wrap ? undefined : wholeWidth(lines, number, split);
  return (
    <section
      ref={setRoot}
      aria-labelledby={named && showHeader ? name : undefined}
      aria-label={named && showHeader ? undefined : said}
      data-slot="diff-viewer"
      data-mode={drawn}
      {...stylex.props(
        framed ? styles.diff : styles.bare,
        ringInsetMarker,
        style
      )}
    >
      {showHeader && (
        <Header
          id={name}
          title={title}
          added={added}
          removed={removed}
          words={words}
        />
      )}
      <Body
        setBody={setBody}
        virtual={virtual}
        wrap={wrap}
        name={words.lines(said)}
      >
        {empty ? (
          <p {...stylex.props(styles.empty)}>
            {lines.length === 0 ? words.nothing : words.same}
          </p>
        ) : (
          <Table
            rows={rows}
            said={said}
            virtual={virtual}
            scroller={body}
            drawing={drawing}
            width={width}
          />
        )}
      </Body>
    </section>
  );
};

/** Prose, changed in the flow of its words. */
const ProseDiff = ({
  oldValue,
  newValue,
  title,
  showHeader,
  label,
  words,
  style,
}: Settled) => {
  const name = useId();
  const named = title !== undefined && title !== "";
  const { lines } = compare(oldValue, newValue);
  const added = countOf(lines, "added");
  const removed = countOf(lines, "removed");
  return (
    <section
      aria-label={(named ? title : label) ?? words.name}
      data-slot="diff-viewer"
      data-mode="inline"
      {...stylex.props(styles.diff, ringInsetMarker, style)}
    >
      {named && showHeader && (
        <Header
          id={name}
          title={title}
          added={added}
          removed={removed}
          words={words}
        />
      )}
      <Prose oldValue={oldValue} newValue={newValue} words={words} />
    </section>
  );
};

/** Every prop with its default, and its words from the I18nProvider. */
const useSettled = (
  {
    mode = "unified",
    splitMinWidth = 640,
    showHeader = true,
    "aria-label": label,
    contextLines = 3,
    review = false,
    showHunkHeaders = false,
    wrap = true,
    virtualizeThreshold = 400,
    oldValue,
    newValue,
    title,
    decisions,
    onDecisionChange,
    style,
  }: DiffViewerProps,
  framed: boolean
): Settled => ({
  oldValue,
  newValue,
  title,
  decisions,
  onDecisionChange,
  style,
  mode,
  splitMinWidth,
  showHeader,
  label,
  contextLines,
  review,
  showHunkHeaders,
  wrap,
  virtualizeThreshold,
  words: useI18n().diffViewer,
  framed,
});

/** What changed between two texts, by line or, for prose, by word. */
export const DiffViewer = (props: DiffViewerProps) => {
  const settled = useSettled(props, true);
  return settled.mode === "inline" ? (
    <ProseDiff {...settled} />
  ) : (
    <LineDiff {...settled} />
  );
};

/** A file's lines, without a box of their own: the file draws it, with its own header. */
const FileLines = (props: DiffViewerProps) => (
  <LineDiff {...useSettled(props, false)} />
);

// ---- DiffViewerFiles -----------------------------------------------------------------------------

type FileChange = "added" | "deleted" | "modified";

/** A file's change and its two texts: a new file was nothing before, a deleted one is nothing after. */
const changeOf = (
  file: DiffViewerFile
): { change: FileChange; oldValue: string; newValue: string } => {
  if (file.oldValue === undefined) {
    return { change: "added", oldValue: "", newValue: file.newValue ?? "" };
  }
  if (file.newValue === undefined) {
    return { change: "deleted", oldValue: file.oldValue, newValue: "" };
  }
  return {
    change: "modified",
    oldValue: file.oldValue,
    newValue: file.newValue,
  };
};

/** "src/routes/index.tsx" as its folder ("src/routes/") and its name ("index.tsx"). */
const partsOf = (path: string) => {
  const cut = path.lastIndexOf("/") + 1;
  return { folder: path.slice(0, cut), name: path.slice(cut) };
};

interface FileProps {
  file: DiffViewerFile;
  change: FileChange;
  oldValue: string;
  newValue: string;
  added: number;
  removed: number;
  foldFrom: number;
  contextLines: number;
  showHunkHeaders: boolean;
  wrap: boolean;
  words: DiffWords;
}

/** One file: its header, which folds it, and its lines. */
const File = ({
  file,
  change,
  oldValue,
  newValue,
  added,
  removed,
  foldFrom,
  contextLines,
  showHunkHeaders,
  wrap,
  words,
}: FileProps) => {
  const [open, setOpen] = useState(added + removed <= foldFrom);
  const { folder, name } = partsOf(file.path);
  const badges = {
    added: words.filesAdded,
    deleted: words.filesDeleted,
    modified: words.filesModified,
  };
  return (
    <section
      data-slot="diff-viewer-file"
      data-change={change}
      aria-label={file.path}
      {...stylex.props(styles.file)}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            data-slot="diff-viewer-file-header"
            {...stylex.props(
              styles.fileHeader,
              open && styles.fileHeaderOpen,
              focusRingInset,
              styles.fileRing
            )}
          >
            <span
              aria-hidden="true"
              {...stylex.props(styles.chevron, open && styles.chevronOpen)}
            >
              <Icon icon={ChevronDownIcon} />
            </span>
            <span dir="ltr" {...stylex.props(styles.path)}>
              {folder === "" ? null : (
                <span {...stylex.props(styles.folder)}>
                  <bdi dir="ltr">{folder}</bdi>
                </span>
              )}
              <span {...stylex.props(styles.name)}>{name}</span>
            </span>
            <span {...stylex.props(styles.badge)}>
              <Badge size="sm">{badges[change]}</Badge>
            </span>
            <Counts
              added={added}
              removed={removed}
              said={words.counts(added, removed)}
              look={styles.fileCounts}
              skipZero
            />
          </button>
        </CollapsibleTrigger>
        {/* UI SDK's own panel, not CollapsibleContent: the file's lines run edge to edge in its box,
            with none of the disclosure's words padding round them. */}
        <CollapsiblePanel>
          {open ? (
            <FileLines
              oldValue={oldValue}
              newValue={newValue}
              title={file.path}
              showHeader={false}
              showHunkHeaders={showHunkHeaders}
              wrap={wrap}
              contextLines={contextLines}
            />
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
};

/** What changes across several files: a block per file, and a line on top counting it all. */
export const DiffViewerFiles = ({
  files,
  total = true,
  foldFrom = 400,
  contextLines = 3,
  showHunkHeaders = true,
  wrap = false,
  "aria-label": label,
  style,
}: DiffViewerFilesProps) => {
  const words = useI18n().diffViewer;
  const counted = files.map((file) => {
    const texts = changeOf(file);
    const { lines } = compare(texts.oldValue, texts.newValue);
    return {
      file,
      ...texts,
      added: countOf(lines, "added"),
      removed: countOf(lines, "removed"),
    };
  });
  const added = counted.reduce((sum, each) => sum + each.added, 0);
  const removed = counted.reduce((sum, each) => sum + each.removed, 0);
  const changed = words.filesFilesChanged(files.length);
  return (
    <section
      aria-label={label ?? words.filesName}
      data-slot="diff-viewer-files"
      {...stylex.props(styles.list, style)}
    >
      {files.length === 0 ? (
        <p {...stylex.props(styles.filesEmpty)}>{words.filesNothing}</p>
      ) : null}
      {total && files.length > 0 ? (
        <p data-slot="diff-viewer-files-total" {...stylex.props(styles.total)}>
          <span>{changed}</span>
          <Counts
            added={added}
            removed={removed}
            said={words.counts(added, removed)}
            look={styles.fileCounts}
            skipZero
          />
        </p>
      ) : null}
      {counted.map((each) => (
        <File
          key={each.file.path}
          file={each.file}
          change={each.change}
          oldValue={each.oldValue}
          newValue={each.newValue}
          added={each.added}
          removed={each.removed}
          foldFrom={foldFrom}
          contextLines={contextLines}
          showHunkHeaders={showHunkHeaders}
          wrap={wrap}
          words={words}
        />
      ))}
    </section>
  );
};
