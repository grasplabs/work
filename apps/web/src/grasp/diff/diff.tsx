// Diff: what changed, before and after. For text and code, unified or side by side, with line
// numbers, added and removed lines tinted and marked at their start (a plus or a minus, never the
// colour alone), the words that changed within a line marked a step deeper, and long unchanged
// stretches folded behind "Show 24 unchanged lines". For prose, the change in the flow of the text.
// Accept and Reject per change, when it is a review.
//
// Learned from GitHub's and GitLab's diffs (the two gutters, the folded runs, the words marked
// within a line), Cursor's and Claude Code's edit review (Accept and Reject per change, the
// change kept readable once decided) and Google Docs' suggestions (prose changed in place).
// Grasp's look: the status tints as grounds, our corner and edge, Geist Mono, quiet numbers.
//
//   <Diff title="invoice.ts" before={old} after={next} />
//   <Diff mode="split" before={old} after={next} />
//   <Diff mode="inline" before={draft} after={edited} />                  prose
//   <Diff before={old} after={next} review onDecide={(change, decision) => …} />
//
// On the `diff` package (9.0.0). A long diff draws only the lines in view, on UI SDK's
// virtualiser. No highlighting: plain text, so it reads the same for every language.
"use client";
// The rows are a grid table of divs, not <table>: a long diff places each row absolutely in its
// scroller, which table elements cannot do, so the table's roles are written out.
/* oxlint-disable jsx-a11y/prefer-tag-over-role */

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { createVirtualizer } from "@ui-sdk/core";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";

import { announce } from "../announce/announce";
import { Button } from "../button";
import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import {
  ChevronDown,
  Cross,
  Icon,
  Minus,
  Plus,
  Tick,
  Undo,
  UpDown,
} from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { arrive } from "../motion/arrive";
import { simply } from "../motion/simply.stylex";
import { scroll } from "../scroll/scroll";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords, withGiven } from "../words/words";
import {
  compare,
  foldsOf,
  hunkHead,
  prose,
  splitRows,
  unifiedRows,
} from "./compute";
import type { Change, Line, Row, SplitRow } from "./compute";
import { diffVars } from "./diff.stylex";
import { diffWords } from "./words";

/** What became of one change in a review. */
export type DiffDecision = "accepted" | "rejected";

/** What a caller may style: where the diff sits and how wide it is. Never its look. */
export type DiffLayoutStyle = LayoutStyle;

/** Every word a Diff shows or says, so a product can translate them. */
export interface DiffWords {
  /** On the button that keeps a change. */
  accept: string;
  /** On the button that turns a change down. */
  reject: string;
  /** On the button that puts a decided change back to undecided. */
  undo: string;
  /** Shown where the buttons stood once a change is kept. */
  accepted: string;
  /** Shown where the buttons stood once a change is turned down. */
  rejected: string;
  /** Said for the plus at an added line's start, and before put-in prose. */
  added: string;
  /** Said for the minus at a removed line's start, and before taken-out prose. */
  removed: string;
  /** The side-by-side columns' names, for a screen reader. */
  before: string;
  after: string;
  /** The unified columns' names, for a screen reader. */
  lineBefore: string;
  lineAfter: string;
  change: string;
  text: string;
  /** Shown when both texts are empty. */
  nothing: string;
  /** Shown when both texts are the same. */
  same: string;
  /** On a folded run: "Show 24 unchanged lines". */
  unchanged: (count: number) => string;
  /** A change's line in a review: "Change 1 of 2: 1 removed, 2 added". */
  changeOf: (at: number, of: number, removed: number, added: number) => string;
  /** The head's counts, said: "7 lines added, 5 removed". */
  counts: (added: number, removed: number) => string;
  /** Said once a change is decided or put back: "Change 2 accepted". */
  said: (at: number, decision: DiffDecision | null) => string;
  /** The name of a long diff's scrolling lines: "invoice.ts, lines". */
  lines: (name: string) => string;
  /** A hunk's head, said (its "@@ -12,7 +12,8 @@" is shown): "Lines 12 to 18 before, lines 12 to 19 after". */
  hunk: (
    oldStart: number,
    oldCount: number,
    newStart: number,
    newCount: number
  ) => string;
}

/** Every prop a Diff takes. */
export interface DiffProps {
  /** The text as it was. */
  before: string;
  /** The text as it is now. */
  after: string;
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
  splitFrom?: number;
  /** What changed: a file's name ("invoice.ts") or the document's. It names the diff. */
  title?: string;
  /**
   * The line over the diff with its title and the count of lines added and removed. Leave it on
   * unless something beside the diff already says them.
   * @default true
   */
  head?: boolean;
  /** Its name for a screen reader when there is no `title`. @default "Changes" */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /**
   * Unchanged lines kept round each change before the rest fold away.
   * @default 3
   */
  context?: number;
  /** Accept and Reject on each change, for a person reviewing an agent's edit. @default false */
  review?: boolean;
  /**
   * A hunk's head, `@@ -12,7 +12,8 @@` as git writes it, before each run of shown lines, for code
   * read by people who know patches. Unified only.
   * @default false
   */
  hunks?: boolean;
  /**
   * Long lines wrap under their own start. False keeps each line whole, and the lines scroll
   * sideways inside the diff, never the page: for code, where a wrapped line misleads.
   * @default true
   */
  wrap?: boolean;
  /** What was decided on each change, by its number from 0, when you keep it. */
  decisions?: Readonly<Record<number, DiffDecision>>;
  /** Called when a change is accepted, rejected, or put back to undecided (`null`). */
  onDecide?: (change: number, decision: DiffDecision | null) => void;
  /**
   * Past this many rows it draws only the lines in view, and stands at most `diff-height` tall.
   * @default 400
   */
  virtualAfter?: number;
  /** Any of its words, in the product's language. The rest stay in English. */
  words?: Partial<DiffWords>;
  /** @deprecated Use `layout`. */
  style?: DiffLayoutStyle;
  /** Layout only: margins, alignment and width. */
  layout?: DiffLayoutStyle;
}

const FORCED = media.forced;

const styles = stylex.create({
  diff: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    width: "100%",
    minWidth: 0,
    overflow: "hidden",
    borderRadius: `min(${grasp.corner}, ${grasp.space4})`,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: grasp.edge,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    color: grasp.ink,
    fontFamily: grasp.fontSans,
  },
  // Drawn inside a box another part draws (a DiffFiles file): the lines alone, no box of their own.
  bare: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    width: "100%",
    minWidth: 0,
    color: grasp.ink,
    fontFamily: grasp.fontSans,
  },
  head: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space3,
    paddingBlock: grasp.space2,
    paddingInline: grasp.space4,
    borderBlockEndWidth: grasp.separatorWidth,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: grasp.line,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  title: {
    minWidth: 0,
    fontFamily: grasp.fontMono,
    fontWeight: grasp.weightMedium,
    overflowWrap: "anywhere",
  },
  counts: {
    display: "flex",
    gap: grasp.space2,
    marginInlineStart: "auto",
    fontVariantNumeric: "tabular-nums",
  },
  plus: { color: grasp.success, fontWeight: grasp.weightMedium },
  minus: { color: grasp.danger, fontWeight: grasp.weightMedium },
  body: { minWidth: 0 },
  // A long diff scrolls inside its own box, drawing only what is in view.
  scroll: {
    maxHeight: grasp.diffHeight,
    overflowY: "auto",
    overscrollBehavior: "auto",
  },
  room: (size: number) => ({ position: "relative", height: size }),
  placed: (start: number) => ({
    position: "absolute",
    insetInline: 0,
    top: 0,
    transform: `translateY(${start}px)`,
  }),
  table: { display: "grid", minWidth: 0 },
  // Lines kept whole: the rows scroll sideways inside the diff, all as wide as the longest.
  sideways: { overflowX: "auto", overscrollBehaviorX: "auto" },
  // Its ch is the rows' (Geist Mono at text-sm), so the width set in ch fits the longest line.
  wide: (width: string) => ({
    minWidth: width,
    fontFamily: grasp.fontMono,
    fontSize: grasp.textSm,
  }),
  codeWhole: { whiteSpace: "pre", overflowWrap: "normal" },
  // A fold's and a hunk's words stay in view while the lines scroll sideways under them.
  stays: {
    position: "sticky",
    insetInlineStart: grasp.space4,
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
  },
  // A hunk's head: where the lines after it stand in both texts, quiet, on the folds' band. The
  // control that opens the run folded before it stands in its gutter, the @@ where the words start.
  hunkRow: {
    alignItems: "center",
    backgroundColor: grasp.diffFoldFill,
    [diffVars.tint]: grasp.diffFoldFill,
  },
  hunkGutter: {
    gridColumn: "1 / span 3",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "stretch",
    minHeight: `calc(${grasp.textSmLine} + 2 * ${grasp.space1})`,
  },
  hunk: {
    display: "flex",
    alignItems: "center",
    minWidth: 0,
    paddingBlock: grasp.space1,
    color: grasp.muted,
    whiteSpace: "pre",
  },
  hunkWords: { position: "sticky" },
  // A line: its numbers, its mark, its words. Long lines wrap; nothing is cut off.
  row: {
    display: "grid",
    alignItems: "start",
    fontFamily: grasp.fontMono,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  // The number columns fit the file's longest number, never narrower than diff-number.
  unified: (number: string) => ({
    gridTemplateColumns: `${number} ${number} ${grasp.space6} minmax(0, 1fr)`,
  }),
  split: { gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" },
  half: (number: string) => ({
    display: "grid",
    gridTemplateColumns: `${number} ${grasp.space6} minmax(0, 1fr)`,
    minWidth: 0,
    alignSelf: "stretch",
  }),
  halfAfter: {
    borderInlineStartWidth: grasp.separatorWidth,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: grasp.line,
  },
  added: {
    backgroundColor: grasp.diffAddedFill,
    [diffVars.tint]: grasp.diffAddedFill,
  },
  removed: {
    backgroundColor: grasp.diffRemovedFill,
    [diffVars.tint]: grasp.diffRemovedFill,
  },
  // Lines kept whole: the numbers and the mark stay at the start (the right, right to left) while
  // the words scroll under them, on the box's ground with the row's tint laid over it.
  pinned: {
    position: "sticky",
    zIndex: 1,
    alignSelf: "stretch",
    backgroundColor: grasp.raised,
    backgroundImage: `linear-gradient(${diffVars.tint}, ${diffVars.tint})`,
  },
  pinStart: { insetInlineStart: 0 },
  pinAt: (offset: string) => ({ insetInlineStart: offset }),
  // An empty side, where a line was only added or only removed.
  blank: { backgroundColor: grasp.diffFoldFill },
  number: {
    paddingInline: grasp.space2,
    color: grasp.muted,
    textAlign: "end",
    fontVariantNumeric: "tabular-nums",
    userSelect: "none",
  },
  mark: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: grasp.textSmLine,
    userSelect: "none",
  },
  markAdded: { color: grasp.success },
  markRemoved: { color: grasp.danger },
  code: {
    minWidth: 0,
    paddingInlineEnd: grasp.space3,
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
    backgroundColor: grasp.diffAddedWord,
    borderRadius: grasp.cornerMark,
    textDecoration: "underline",
    textDecorationColor: grasp.success,
    textUnderlineOffset: grasp.space1,
  },
  wordRemoved: {
    backgroundColor: grasp.diffRemovedWord,
    borderRadius: grasp.cornerMark,
    textDecoration: "line-through",
    textDecorationColor: grasp.danger,
  },
  // The last row's fold follows the box's rounded foot, so its focus ring (drawn inside it) is not
  // cut by the box's corners.
  foldLast: {
    borderEndStartRadius: `min(${grasp.corner}, ${grasp.space4})`,
    borderEndEndRadius: `min(${grasp.corner}, ${grasp.space4})`,
  },
  // The fold's ring stands a ring's width in from its edges: drawn on them it lay on the box's own
  // border, a second square border inside a rounded box. Last, it follows the rounded foot.
  foldRing: { outlineOffset: `calc(-2 * ${grasp.ringWidth})` },
  // A folded run of unchanged lines: the whole row is its button.
  fold: {
    [iconVars.size]: grasp.iconSm,
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    width: "100%",
    // A finger needs 44px; a pointer, the row's own height.
    minHeight: { default: null, [media.coarse]: grasp.tap },
    margin: 0,
    paddingBlock: grasp.space1,
    paddingInline: grasp.space4,
    // Its band is a fill, which forced colours drop: a line above and below marks it there.
    borderWidth: 0,
    borderBlockWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    // Hover lays a row's own hover (a tree's, a table's: ghost-fill-hover) over the band. The quiet
    // fill's hover was the band's own soft in light, so nothing moved there.
    backgroundColor: grasp.diffFoldFill,
    backgroundImage: {
      default: null,
      ":hover": {
        default: null,
        [media.hover]: `linear-gradient(${grasp.ghostFillHover}, ${grasp.ghostFillHover})`,
      },
    },
    // Ink on the hover fill, as a quiet button's words: muted on it fell to 4.4:1 in dark.
    color: {
      default: grasp.muted,
      ":hover": { default: grasp.muted, [media.hover]: grasp.ink },
    },
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    textAlign: "start",
    cursor: "pointer",
  },
  // A change's head in a review: which change, and its answers.
  changeHead: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
    paddingBlock: grasp.space1,
    paddingInline: grasp.space3,
    backgroundColor: grasp.diffFoldFill,
    borderBlockStartWidth: grasp.separatorWidth,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: grasp.line,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  changeName: { color: grasp.muted, minWidth: 0 },
  // The answers, at the end of the head. They and the result they give way to stand in one cell,
  // so the head keeps its width and height whatever is decided, and nothing beside it moves.
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
    gap: grasp.space2,
    // Coming in it is visible at once, so it can take focus, and fades up.
    transitionProperty: "opacity",
    transitionDuration: simply.swap,
    transitionTimingFunction: grasp.ease,
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
    gap: grasp.space1,
    minHeight: grasp.controlSm,
    paddingInline: grasp.space3,
    borderRadius: `calc(${grasp.controlSm} / 2)`,
    cornerShape: grasp.cornerShape,
    color: grasp.ink,
    fontWeight: grasp.weightMedium,
    transitionProperty: "opacity",
    transitionDuration: simply.swap,
    transitionTimingFunction: grasp.ease,
  },
  resultKept: { backgroundColor: grasp.successSoft },
  resultTurnedDown: { backgroundColor: grasp.dangerSoft },
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
    transitionDuration: simply.mark,
    transitionTimingFunction: grasp.ease,
  },
  resultMarkAway: {
    opacity: 0,
    transform: {
      default: `scale(${grasp.resultMarkFrom})`,
      [media.reduced]: "none",
    },
    transitionDuration: simply.swap,
  },
  kept: { color: grasp.success },
  turnedDown: { color: grasp.danger },
  resultWord: {
    transitionProperty: "opacity, transform",
    transitionDuration: simply.swap,
    transitionDelay: simply.follow,
    transitionTimingFunction: grasp.ease,
  },
  resultWordAway: {
    opacity: 0,
    transform: {
      default: `translateX(calc(-1 * ${grasp.resultShift}))`,
      [media.reduced]: "none",
    },
    transitionDelay: "0s",
  },
  // The side a decision leaves behind stands back, still readable: the removed lines of an
  // accepted change, the added lines of a rejected one.
  settles: {
    transitionProperty: "opacity",
    transitionDuration: simply.mark,
    transitionTimingFunction: grasp.ease,
  },
  settled: { opacity: grasp.dim },
  // Prose: the change in the flow of the words.
  prose: {
    margin: 0,
    paddingBlock: grasp.space4,
    paddingInline: grasp.space5,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  ins: {
    backgroundColor: grasp.diffAddedWord,
    textDecoration: "underline",
    textDecorationColor: grasp.success,
    textUnderlineOffset: grasp.space1,
    borderRadius: grasp.cornerMark,
  },
  del: {
    backgroundColor: grasp.diffRemovedWord,
    textDecoration: "line-through",
    textDecorationColor: grasp.danger,
    borderRadius: grasp.cornerMark,
  },
  empty: {
    paddingBlock: grasp.space4,
    paddingInline: grasp.space4,
    color: grasp.muted,
    fontSize: grasp.textSm,
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
          // A piece has no id; its place in the line is its key.
          // biome-ignore lint/suspicious/noArrayIndexKey: pieces never reorder
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
      <Icon icon={added ? Plus : Minus} />
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

/** Whether a decision left this line behind: the removed lines of an accepted change, the added of a rejected. */
const leftBehind = (
  line: Line | undefined,
  decisions: Readonly<Record<number, DiffDecision>>
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
  decisions: Readonly<Record<number, DiffDecision>>;
  /** The lines a fold just let out: they fade in. */
  fresh: ReadonlySet<string>;
  onUnfold: (
    row: { key: string; from: number; count: number },
    byKeys: boolean
  ) => void;
  onDecide: (
    change: Change,
    decision: DiffDecision | null,
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
          focus.inside,
          styles.foldRing
        )}
      >
        <span {...stylex.props(styles.stays)}>
          <Icon icon={ChevronDown} />
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
      <Icon icon={kept ? Tick : Cross} />
    </span>
    <span {...stylex.props(styles.resultWord, !shown && styles.resultWordAway)}>
      {children}
    </span>
  </span>
);

/**
 * A change's head in a review: which change, and its answers. An answer is taken at once and can
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
              icon={Cross}
              aria-describedby={described}
              onClick={(event) => {
                drawing.onDecide(change, "rejected", event.detail === 0);
              }}
            >
              {words.reject}
            </Button>
            <Button
              size="sm"
              variant="quiet"
              icon={Tick}
              data-diff-answer="accept"
              aria-describedby={described}
              onClick={(event) => {
                drawing.onDecide(change, "accepted", event.detail === 0);
              }}
            >
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
              icon={Undo}
              data-diff-answer="undo"
              aria-describedby={described}
              onClick={(event) => {
                drawing.onDecide(change, null, event.detail === 0);
              }}
            >
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
        drawing.fresh.has(row.key) && arrive.in
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
      drawing.fresh.has(row.key) && arrive.in
    )}
  >
    <Side line={row.left} after={false} drawing={drawing} />
    <Side line={row.right} after drawing={drawing} />
  </div>
);

/**
 * A hunk's head: "@@ -12,7 +12,8 @@", said in words. When unchanged lines are folded just before it,
 * the control that opens them stands in its gutter, named "Show 10 unchanged lines" (its tip too).
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
  const gutter = `calc(2 * ${drawing.number} + ${grasp.space6})`;
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
          !drawing.wrap && [styles.pinned, styles.pinStart]
        )}
      >
        {fold === undefined ? null : (
          <Button
            variant="ghost"
            size="xs"
            icon={UpDown}
            aria-label={drawing.words.unchanged(fold.count)}
            data-diff-unfold=""
            onClick={(event) => {
              drawing.onUnfold(fold, event.detail === 0);
            }}
          />
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
  const size = useSyncExternalStore(
    subscribe,
    () => win.virtual.size(),
    () => rows.length * ROW_GUESS
  );
  return (
    <div {...stylex.props(styles.room(size))}>
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

/** The line over the diff: its title and how many lines were added and removed. */
const Head = ({
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
  <div {...stylex.props(styles.head)}>
    {title !== undefined && title !== "" && (
      <span id={id} {...stylex.props(styles.title)}>
        {title}
      </span>
    )}
    <span {...stylex.props(styles.counts)}>
      <span aria-hidden="true" {...stylex.props(styles.plus)}>
        +{added}
      </span>
      <span aria-hidden="true" {...stylex.props(styles.minus)}>
        −{removed}
      </span>
      <span {...stylex.props(visuallyHidden)}>
        {words.counts(added, removed)}
      </span>
    </span>
  </div>
);

/** Prose: the change in the flow of the words. */
const Prose = ({
  before,
  after,
  words,
}: {
  before: string;
  after: string;
  words: DiffWords;
}) => (
  <p {...stylex.props(styles.prose)}>
    {prose(before, after).map((piece, index) => {
      if (piece.kind === "same") {
        return piece.text;
      }
      const Tag = piece.kind === "added" ? "ins" : "del";
      return (
        // A piece has no id; its place in the text is its key.
        // biome-ignore lint/suspicious/noArrayIndexKey: pieces never reorder
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
const NO_DECISIONS: Readonly<Record<number, DiffDecision>> = {};
const NO_FRESH: ReadonlySet<string> = new Set();

/** Where focus goes after a press by keys took its button away. */
type Target = { change: number; to: "undo" | "accept" } | { change: null };

const modelOf = (before: string, after: string) => ({
  before,
  after,
  ...compare(before, after),
});

/** The lines and changes of two texts, and what the person did with them: folds let out, decisions. */
const useModel = (before: string, after: string) => {
  // Worked out once per pair of texts.
  const [model, setModel] = useState(() => modelOf(before, after));
  // The folds let out, by their key, with how many lines each held.
  const [open, setOpen] = useState(NO_FOLDS);
  // The lines the last fold let out: they fade in.
  const [fresh, setFresh] = useState(NO_FRESH);
  const [own, setOwn] = useState(NO_DECISIONS);
  // Folds and decisions belong to these two texts: new texts start afresh.
  if (model.before !== before || model.after !== after) {
    setModel(modelOf(before, after));
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

/** Every prop of Diff, with its defaults filled and its words whole. */
type Settled = Omit<
  Required<DiffProps>,
  | "title"
  | "decisions"
  | "onDecide"
  | "words"
  | "style"
  | "layout"
  | "aria-label"
> &
  Pick<DiffProps, "title" | "decisions" | "onDecide" | "layout"> & {
    words: DiffWords;
    /** In its own box (Diff), or bare inside another part's (DiffLines). */
    framed: boolean;
  };

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
 * With lines kept whole, how wide the rows stand: the longest line (Geist Mono: a character is a ch,
 * a tab two) and the gutter before it, so every row's tint runs the whole way as they scroll.
 */
const wholeWidth = (lines: readonly Line[], number: string, split: boolean) => {
  // One ch more than the longest line: a ch is fractional, and a line that only just fits would
  // break at its last break point.
  const longest =
    Math.max(
      0,
      ...lines.map((line) => line.text.replaceAll("\t", "  ").length)
    ) + 1;
  if (split) {
    return `calc(2 * (${number} + ${grasp.space6} + ${longest}ch + ${grasp.space3}))`;
  }
  return `calc(2 * ${number} + ${grasp.space6} + ${longest}ch + ${grasp.space3})`;
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
        scrolls && scroll.bar,
        focus.inside
      )}
    >
      {children}
    </div>
  );
};

/** The diff by line: unified or side by side, with folds, and the answers when reviewing. */
const LineDiff = (props: Settled) => {
  const {
    before,
    after,
    mode,
    splitFrom,
    title,
    head: showHead,
    label,
    context,
    review,
    hunks,
    wrap,
    decisions: given,
    onDecide,
    virtualAfter,
    words,
    layout,
    framed,
  } = props;
  // Side by side only where both sides have room; narrower, it falls back to unified.
  const { setRoot, split, drawn } = useSplit(mode, splitFrom);
  const { model, open, setOpen, fresh, setFresh, own, setOwn } = useModel(
    before,
    after
  );
  const { lines, changes } = model;
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const setTarget = useFocusAfter(body);
  const name = useId();
  const named = title !== undefined && title !== "";
  const said = named ? title : label;

  const folds = foldsOf(lines, changes, context, open);
  const rows: AnyRow[] = split
    ? splitRows(lines, changes, folds, review)
    : unifiedRows(lines, changes, folds, review, hunks);
  const virtual = rows.length > virtualAfter;

  // Wide enough for the longest number, with the column's room either side.
  const digits = String(
    Math.max(
      1,
      ...lines.map((line) => Math.max(line.oldNo ?? 0, line.newNo ?? 0))
    )
  ).length;
  const number = `max(${grasp.diffNumber}, calc(${digits}ch + 2 * ${grasp.space2}))`;
  const drawing: Drawing = {
    split,
    wrap,
    number: `max(${grasp.diffNumber}, calc(${digits}ch + 2 * ${grasp.space2}))`,
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
      onDecide?.(change.index, decision);
    },
  };

  const empty = lines.length === 0 || (changes.length === 0 && open.size === 0);
  const width = wrap ? undefined : wholeWidth(lines, number, split);
  return (
    <section
      ref={setRoot}
      aria-labelledby={named && showHead ? name : undefined}
      aria-label={named && showHead ? undefined : said}
      data-slot="diff"
      data-mode={drawn}
      {...stylex.props(framed ? styles.diff : styles.bare, layout)}
    >
      {showHead && (
        <Head
          id={name}
          title={title}
          added={countOf(lines, "added")}
          removed={countOf(lines, "removed")}
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
  before,
  after,
  title,
  head: showHead,
  label,
  words,
  layout,
}: Settled) => {
  const name = useId();
  const named = title !== undefined && title !== "";
  const { lines } = compare(before, after);
  return (
    <section
      aria-label={named ? title : label}
      data-slot="diff"
      data-mode="inline"
      {...stylex.props(styles.diff, layout)}
    >
      {named && showHead && (
        <Head
          id={name}
          title={title}
          added={countOf(lines, "added")}
          removed={countOf(lines, "removed")}
          words={words}
        />
      )}
      <Prose before={before} after={after} words={words} />
    </section>
  );
};

/** Every prop with its default, and its words: the product's by its catalogue, else English; the caller's win. */
const useSettled = (
  {
    mode = "unified",
    splitFrom = 640,
    head = true,
    label: labelDeprecated,
    "aria-label": labelGiven,
    context = 3,
    review = false,
    hunks = false,
    wrap = true,
    virtualAfter = 400,
    words,
    style: styleProp,
    layout,
    ...rest
  }: DiffProps,
  framed: boolean
): Settled => {
  const { name: label, ...catalogued } = withGiven(
    useWords("diff", diffWords),
    { ...words, name: labelGiven ?? labelDeprecated }
  );
  return {
    ...rest,
    layout: layout ?? styleProp,
    mode,
    splitFrom,
    head,
    label,
    context,
    review,
    hunks,
    wrap,
    virtualAfter,
    words: catalogued,
    framed,
  };
};

/** What changed between two texts, by line or, for prose, by word. */
export const Diff = (props: DiffProps) => {
  const settled = useSettled(props, true);
  return settled.mode === "inline" ? (
    <ProseDiff {...settled} />
  ) : (
    <LineDiff {...settled} />
  );
};

/**
 * A diff's lines without its own box, for a part that draws the box round them with a head of its
 * own (DiffFiles' file). By line only. Not on the Diff entry: a page wants Diff.
 */
export const DiffLines = (props: Omit<DiffProps, "mode" | "head">) => (
  <LineDiff {...useSettled({ ...props, head: false }, false)} />
);
