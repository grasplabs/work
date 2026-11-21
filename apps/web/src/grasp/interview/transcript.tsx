// InterviewTranscript: the conversation, turn by turn. Each run of turns by one speaker starts with
// their portrait or initials and their name, in ink; each turn has its time, a button that sends
// the sound there when there is sound or an `onSeek`, plain words when there is not, and with no
// times at all the turns are numbered by passage. Chapters are headings. A highlight is a <mark>
// with its kind's label in small quiet words, never only a title and never a colour. By default
// (`margin`) a thin rule stands beside its lines in the turn's end margin, with the kind's word at
// it on a wide transcript (a container query on the transcript's own width, with CSS anchor
// positioning), and the kinds are counted once above; the margin shows only once it is measured
// placed right, and until then, or where it cannot be, the passage is underlined with its kind's
// word after it. `underline` always draws it so. Nothing is filled at rest: hovering or focusing a
// turn washes its highlights.
// The active turn is marked (aria-current) and kept in view inside the transcript's own scroller.
//
//   <Interview turns={turns} speakers={speakers} chapters={chapters} highlights={highlights}>
//     <InterviewTranscript height="28rem" />
//   </Interview>
//   <InterviewTranscript turns={lines} />            alone, with the interview's props on it
//
// The keyboard, one roving stop: the transcript is a table, a time beside each turn's words, whose
// rows are the turns, and the whole of it is one tab stop, a turn's row. The stop is the turn with focus last, or the
// active turn, or the first. Up and Down move turn by turn, Page Up and Page
// Down ten at a time, Home and End to the first and the last; Enter or Space on a turn goes to it
// (it becomes active and the sound goes to its start). Inside the turn with the stop, its time
// button is reachable too: Tab from the turn goes to its time button, Tab again leaves the
// transcript; in every other turn the time button is out of the tab order, so fifty turns never
// make fifty stops. Leaving the transcript gives the stop back to the active turn.
//
// Long transcripts: every turn is in the page (find in page, a screen reader and an agent read them
// all), and each turn is drawn only when near the view (`content-visibility: auto`, with a size to
// hold its room), so 5,000 turns stay cheap with no virtualiser. Scrolling to the active turn moves
// only the transcript's own scroller (`height`), never the page, and does not glide with reduced
// motion. Without `height` the transcript grows with the page and nothing scrolls it.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import {
  Fragment,
  createElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { FocusEvent, KeyboardEvent, ReactNode } from "react";

import { Avatar, AvatarImage, AvatarFallback } from "../avatar";
import { focus } from "../focus/focus";
import { scroll } from "../scroll/scroll";
import { grasp, media } from "../tokens/tokens.stylex";
import { useInterview } from "./context";
import type { InterviewValue } from "./context";
import { Interview } from "./interview";
import { langOf } from "./lang";
import type { InterviewLayoutStyle } from "./layout";
import { MarginRule, marginStyles, proveMargin } from "./margin";
import { marginVars } from "./margin.stylex";
import { KindPill } from "./pill";
import { foundPiecesOf, hasWords, keyOf, piecesOf, timed } from "./read";
import type { Piece } from "./read";
import { createRowSource, FIRST_ROWS, groupsOf, rowsOf } from "./rows";
import type { RowSource, TranscriptRow } from "./rows";
import { TranscriptSearch } from "./search";
import { tones } from "./tone";
import { marginMarker, toneVars, turnMarker } from "./tone.stylex";
import type {
  InterviewDataProps,
  InterviewHighlightLook,
  InterviewKindMark,
  InterviewMatch,
  InterviewPerson,
  InterviewTurn,
  InterviewWords,
  PlacedHighlight,
} from "./types";

/** Every prop an InterviewTranscript takes. Alone, outside an Interview, it takes the interview's props too. */
export interface InterviewTranscriptProps extends InterviewDataProps {
  /**
   * Its height, as a length ("28rem"): it then scrolls within itself and keeps the active turn in
   * view. Without it, it grows with the page.
   */
  height?: string;
  /**
   * The chapter headings' level, to fit the page's outline.
   * @default 4
   */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  /** @deprecated Use `headingLevel`. */
  level?: 2 | 3 | 4 | 5 | 6;
  /**
   * How a highlight is marked. `margin`: nothing in the words at rest, a thin rule beside their
   * lines in the turn's end margin, the kind's word at the rule on a transcript 36rem wide or more
   * (after the words when narrower), and, with two or more, the kinds counted once above the turns; where the rule
   * cannot be placed exactly, it is drawn as `underline`. `underline`: a hairline under the words
   * and the kind's word after them, nothing filled at rest. Either way the kind is told by its
   * word, never by a colour; hover or focus on a turn washes its highlights.
   * Inside an Interview, the Interview's `highlightLook` stands in without it.
   * @default "margin"
   */
  highlightLook?: InterviewHighlightLook;
  /** @deprecated Use `layout`. */
  style?: InterviewLayoutStyle;
  /** Layout only: where it sits and how wide it is. */
  layout?: InterviewLayoutStyle;
}

const COARSE = media.coarse;
/** A transcript wide enough for a margin column of kinds. */
const WIDE = "@container (width >= 36rem)";
/** A browser that places the margin's rules beside the words they mark. */
const ANCHORS = "@supports (anchor-name: --a)";

// An edge of the scroller with turns past it fades out (watchEdges marks it), so a line is never
// cut hard against the hairline: space-10 tall, clear for the space-2 next to the hairline. The
// hairline itself stays whole: the mask keeps the border's own pixels opaque. As Thread's fades.
const LINE_EDGE = grasp.hairline;
const fadeTop = `black ${LINE_EDGE}, transparent ${LINE_EDGE}, transparent calc(${LINE_EDGE} + ${grasp.space2}), black calc(${LINE_EDGE} + ${grasp.space10})`;
const fadeBottom = `black calc(100% - ${LINE_EDGE} - ${grasp.space10}), transparent calc(100% - ${LINE_EDGE} - ${grasp.space2}), transparent calc(100% - ${LINE_EDGE}), black calc(100% - ${LINE_EDGE})`;

const styles = stylex.create({
  root: {
    position: "relative",
    // The margin's column is there only when the transcript itself is wide enough.
    containerType: "inline-size",
    minWidth: 0,
    fontFamily: grasp.fontSans,
    color: grasp.text,
  },
  // Its own scroller: a hairline above and below says where its room ends.
  scroller: {
    overflowY: "auto",
    overscrollBehavior: "auto",
    borderBlockWidth: grasp.hairline,
    borderBlockStyle: "solid",
    borderBlockColor: { default: grasp.line, [media.forced]: "CanvasText" },
    borderInlineWidth: 0,
    // Where a turn brought into view stands: below the top's fade, whole.
    scrollPaddingTop: grasp.space8,
    maskImage: {
      default: null,
      ":is([data-under-start]:not([data-under-end]))": `linear-gradient(to bottom, ${fadeTop}, black)`,
      ":is([data-under-end]:not([data-under-start]))": `linear-gradient(to bottom, ${fadeBottom})`,
      ":is([data-under-start][data-under-end])": `linear-gradient(to bottom, ${fadeTop}, ${fadeBottom})`,
    },
  },
  height: (height: string) => ({ blockSize: height }),
  // A table for what it means (a time beside each turn's words), laid out as blocks and grids.
  table: {
    display: "block",
    inlineSize: "100%",
    borderCollapse: "collapse",
  },
  chapter: {
    display: "grid",
    minWidth: 0,
  },
  heading: {
    margin: 0,
    paddingBlockStart: grasp.space5,
    paddingBlockEnd: grasp.space2,
    paddingInline: grasp.space3,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    letterSpacing: grasp.trackingTag,
    textTransform: "uppercase",
    color: grasp.muted,
    overflowWrap: "anywhere",
  },
  headingFirst: {
    paddingBlockStart: grasp.space2,
  },
  turn: {
    position: "relative",
    display: "grid",
    // On a touch screen turns stand a finger apart, so their times' 44px never meet.
    // The times' column: room for "1:02:05"; narrower on a phone.
    gridTemplateColumns: {
      default: `${grasp.space16} minmax(0, 1fr)`,
      [media.belowPhone]: `${grasp.space12} minmax(0, 1fr)`,
    },
    gridTemplateRows: "auto auto",
    gridTemplateAreas: '". who" "time words"',
    columnGap: grasp.space2,
    rowGap: 0,
    paddingBlock: { default: grasp.space2, [COARSE]: grasp.space3 },
    paddingInlineEnd: grasp.space3,
    borderRadius: grasp.cornerMark,
    cornerShape: grasp.cornerShape,
    // In forced colours the active turn's edge is a real line; at rest it is there but unseen.
    borderInlineStartWidth: grasp.ringWidth,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: "transparent",
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [media.hover]: grasp.ghostFillHover },
    },
    // Drawn only near the view; the room it holds until then is about two lines and its padding.
    contentVisibility: "auto",
    containIntrinsicBlockSize: `auto calc(2 * ${grasp.textMdLine} + 2 * ${grasp.space2})`,
    scrollMarginBlock: grasp.space4,
  },
  // Windowed, a turn is drawn only near the view anyway, and is measured as it really is.
  drawn: {
    contentVisibility: "visible",
  },
  // The room of the rows not drawn, above and below the ones that are.
  spacer: {
    display: "block",
  },
  // A turn that starts a run has its speaker's chip above its words.
  runStart: {
    rowGap: grasp.space2,
    paddingBlockStart: grasp.space4,
    containIntrinsicBlockSize: `auto calc(3 * ${grasp.textMdLine} + ${grasp.space4} + ${grasp.space2})`,
  },
  active: {
    backgroundColor: grasp.soft,
    borderInlineStartColor: {
      default: grasp.mintDeep,
      [media.forced]: "Highlight",
    },
  },
  // The words' cell spans both rows and lends them to its speaker and its words, so the time in
  // its own cell stands on the words' first line.
  cell: {
    display: "grid",
    padding: 0,
    gridColumn: 2,
    gridRow: "1 / span 2",
    gridTemplateRows: "subgrid",
    minWidth: 0,
  },
  timeCell: {
    gridArea: "time",
    padding: 0,
    display: "grid",
    justifyItems: "end",
    alignItems: "start",
    minWidth: 0,
  },
  headingRow: {
    display: "block",
  },
  headingCell: {
    display: "block",
    padding: 0,
    textAlign: "start",
    fontWeight: "inherit",
  },
  who: {
    gridRow: 1,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: grasp.space2,
    rowGap: grasp.space1,
    minWidth: 0,
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    maxWidth: "100%",
    minWidth: 0,
    // The portrait or initials and the name in ink, on the page's own ground: no tint.
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  // The portrait or initials in a thin ring of the speaker's tone: the same tone as their stretch on
  // the timeline, so the two agree; in forced colours the ring is the system's line.
  sign: {
    display: "inline-flex",
    flexShrink: 0,
    borderRadius: grasp.cornerCircle,
    outlineWidth: grasp.ringWidth,
    outlineStyle: "solid",
    outlineColor: { default: toneVars.mid, [media.forced]: "CanvasText" },
    outlineOffset: grasp.hairline,
  },
  chipName: {
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  role: {
    minWidth: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
    overflowWrap: "anywhere",
  },
  time: {
    // On the first line of the words: its own line box is the words' line box.
    minBlockSize: grasp.textMdLine,
    display: "inline-flex",
    alignItems: "center",
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  seek: {
    position: "relative",
    margin: 0,
    marginInlineEnd: `calc(-1 * ${grasp.space1})`,
    paddingBlock: 0,
    paddingInline: grasp.space1,
    borderWidth: { default: 0, [media.forced]: grasp.hairline },
    borderStyle: "solid",
    borderColor: "ButtonText",
    borderRadius: grasp.cornerMark,
    cornerShape: grasp.cornerShape,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [media.hover]: grasp.ghostFillHover },
      ":active": grasp.ghostFillPress,
    },
    font: "inherit",
    color: {
      default: grasp.muted,
      ":hover": { default: null, [media.hover]: grasp.ink },
    },
    cursor: "pointer",
    touchAction: "manipulation",
  },
  // A finger needs 44px: on a touch screen an unseen area round the time makes up the difference.
  reach: {
    position: "absolute",
    insetInline: {
      default: 0,
      [COARSE]: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
    },
    insetBlock: {
      default: 0,
      [COARSE]: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
    },
  },
  words: {
    gridRow: 2,
    margin: 0,
    minWidth: 0,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    color: grasp.text,
    overflowWrap: "anywhere",
  },
  // A highlight: the words in their own colour, nothing filled at rest. Under the pointer, or with
  // keyboard focus on its turn, a neutral wash, so the eye finds it; in forced colours none.
  mark: {
    borderRadius: grasp.cornerMark,
    color: "inherit",
    boxDecorationBreak: "clone",
    backgroundColor: {
      default: "transparent",
      [stylex.when.ancestor(":hover", turnMarker)]: {
        default: null,
        [media.hover]: grasp.ghostFillPress,
        [media.forced]: "transparent",
      },
      [stylex.when.ancestor(":focus-visible", turnMarker)]: {
        default: grasp.ghostFillPress,
        [media.forced]: "transparent",
      },
    },
    transitionProperty: "background-color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  // Underline: a real line under the words, a hairline in muted ink, clear of the descenders, so
  // it stays in forced colours too.
  underline: {
    textDecorationLine: "underline",
    textDecorationThickness: grasp.hairline,
    textDecorationColor: { default: grasp.muted, [media.forced]: "CanvasText" },
    textUnderlineOffset: grasp.linkUnderlineOffset,
    textDecorationSkipInk: "auto",
  },
  // A match of the words searched for: a line round the words, never the highlights' tinted wash,
  // so the two never read alike; in forced colours a line too, on the page's own ground.
  found: {
    paddingInline: 0,
    borderRadius: grasp.cornerMark,
    backgroundColor: { default: "transparent", [media.forced]: "Canvas" },
    color: { default: "inherit", [media.forced]: "CanvasText" },
    outlineWidth: grasp.hairline,
    outlineStyle: "solid",
    outlineColor: { default: grasp.ink, [media.forced]: "CanvasText" },
    outlineOffset: 0,
    boxDecorationBreak: "clone",
  },
  // The match it is on: filled in ink, the strongest mark in the transcript; the system's
  // selection colours in forced colours.
  foundCurrent: {
    backgroundColor: { default: grasp.ink, [media.forced]: "Highlight" },
    color: { default: grasp.raised, [media.forced]: "HighlightText" },
    outlineColor: { default: grasp.ink, [media.forced]: "Highlight" },
  },
  // With search, the field above and the turns under it.
  searching: {
    display: "grid",
    gap: grasp.space3,
    minWidth: 0,
  },
  // The kind's word after the passage: small, quiet, in sentence case, a thin space from the last
  // word and never wrapped apart from it (nothing between them to break at).
  kind: {
    marginInlineStart: grasp.space1,
    marginInlineEnd: grasp.hairline,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightRegular,
    color: { default: grasp.muted, [media.forced]: "CanvasText" },
    whiteSpace: "nowrap",
  },
  // Margin, placed, on a wide transcript where the margin can hold it: the word after the passage
  // is said, not shown, as the margin shows it; unless its rule gave way (margin.tsx, giveWay).
  kindSaid: {
    position: {
      default: null,
      ":not([data-collides])": {
        default: null,
        [stylex.when.ancestor(":is([data-margin=placed])", marginMarker)]: {
          default: null,
          [WIDE]: "absolute",
        },
      },
    },
    inlineSize: {
      default: null,
      ":not([data-collides])": {
        default: null,
        [stylex.when.ancestor(":is([data-margin=placed])", marginMarker)]: {
          default: null,
          [WIDE]: 1,
        },
      },
    },
    blockSize: {
      default: null,
      ":not([data-collides])": {
        default: null,
        [stylex.when.ancestor(":is([data-margin=placed])", marginMarker)]: {
          default: null,
          [WIDE]: 1,
        },
      },
    },
    overflow: {
      default: null,
      ":not([data-collides])": {
        default: null,
        [stylex.when.ancestor(":is([data-margin=placed])", marginMarker)]: {
          default: null,
          [WIDE]: "hidden",
        },
      },
    },
    clipPath: {
      default: null,
      ":not([data-collides])": {
        default: null,
        [stylex.when.ancestor(":is([data-margin=placed])", marginMarker)]: {
          default: null,
          [WIDE]: "inset(50%)",
        },
      },
    },
  },
  // Margin, until placed (and for good where it cannot be): the passage underlined, as underline
  // marks it, so it is marked either way.
  marginMark: {
    // Only where the rule and the pill stand in the margin's column: narrow, the pill follows the
    // words and no rule is drawn, so the underline still marks them.
    textDecorationLine: {
      default: "underline",
      ":not([data-collides])": {
        default: "underline",
        [stylex.when.ancestor(":is([data-margin=placed])", marginMarker)]: {
          default: "underline",
          [WIDE]: "none",
        },
      },
    },
    textDecorationThickness: grasp.hairline,
    textDecorationColor: { default: grasp.muted, [media.forced]: "CanvasText" },
    textUnderlineOffset: grasp.linkUnderlineOffset,
    textDecorationSkipInk: "auto",
  },
  // Margin: a turn keeps a column at its end for the kinds' words, on a wide transcript.
  turnMargin: {
    [marginVars.ruleEnd]: {
      default: `calc(${grasp.space3} / 2)`,
      [stylex.when.ancestor(":is([data-margin=placed])", marginMarker)]: {
        default: null,
        [WIDE]: `calc(${grasp.space3} + ${grasp.space24} + ${grasp.space3} / 2)`,
      },
    },
    gridTemplateColumns: {
      default: `${grasp.space16} minmax(0, 1fr)`,
      [media.belowPhone]: `${grasp.space12} minmax(0, 1fr)`,
      [stylex.when.ancestor(":is([data-margin=placed])", marginMarker)]: {
        default: null,
        [WIDE]: `${grasp.space16} minmax(0, 1fr) calc(${grasp.space24} + ${grasp.space3})`,
      },
    },
    gridTemplateAreas: {
      default: '". who" "time words"',
      [stylex.when.ancestor(":is([data-margin=placed])", marginMarker)]: {
        default: null,
        [WIDE]: '". who ." "time words ."',
      },
    },
  },
  // The rule (margin.tsx) stands only beside a column of pills, on a wide transcript: narrow, the
  // pill follows its words and the rule goes with it. It goes to ink while the pointer or keyboard
  // focus is on its turn.
  ruleLit: {
    display: {
      default: "none",
      ":not([data-collides])": {
        default: "none",
        [ANCHORS]: { default: "none", [WIDE]: "block" },
      },
    },
    borderInlineStartColor: {
      default: grasp.quiet,
      [stylex.when.ancestor(":hover", turnMarker)]: {
        default: null,
        [media.hover]: grasp.ink,
      },
      [stylex.when.ancestor(":focus-visible", turnMarker)]: grasp.ink,
      [media.forced]: "CanvasText",
    },
  },
  // The kind's word at its rule, on the passage's first line, in the margin's column.
  note: {
    position: "absolute",
    display: {
      default: "none",
      ":not([data-collides])": {
        default: "none",
        [ANCHORS]: { default: "none", [WIDE]: "block" },
      },
    },
    visibility: {
      default: "hidden",
      [stylex.when.ancestor(":is([data-margin=placed])", marginMarker)]:
        "visible",
    },
    insetBlockStart: "anchor(start)",
    insetInlineEnd: grasp.space3,
    inlineSize: grasp.space24,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: { default: grasp.muted, [media.forced]: "CanvasText" },
    overflowWrap: "anywhere",
    pointerEvents: "none",
  },
  // Margin: the kinds present, counted once, in a quiet line above the transcript.
  legend: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: grasp.space2,
    rowGap: grasp.space1,
    margin: 0,
    paddingBlock: 0,
    // On the words' edge: past the active line and the times' column.
    paddingInlineStart: {
      default: `calc(${grasp.ringWidth} + ${grasp.space16} + ${grasp.space2})`,
      [media.belowPhone]: `calc(${grasp.ringWidth} + ${grasp.space12} + ${grasp.space2})`,
    },
    paddingInlineEnd: grasp.space3,
    listStyle: "none",
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  legendItem: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  // The legend and the turns under it.
  withLegend: {
    display: "grid",
    gap: grasp.space3,
    minWidth: 0,
  },
});

/** The place a key moves the stop to, or null for a key that does not move it. */
const moveFor = (key: string, at: number, count: number): number | null => {
  const last = count - 1;
  const moves: Record<string, number> = {
    ArrowDown: at + 1,
    ArrowUp: at - 1,
    PageDown: at + 10,
    PageUp: at - 10,
    Home: 0,
    End: last,
  };
  const to = moves[key];
  return to === undefined ? null : Math.min(Math.max(to, 0), last);
};

/** The turn an element is in, by its place, or null. */
const turnIn = (target: EventTarget | null) => {
  const element =
    target instanceof Element
      ? target.closest<HTMLElement>("[data-turn]")
      : null;
  const at = element === null ? Number.NaN : Number(element.dataset.turn);
  return Number.isNaN(at) || element === null ? null : { element, at };
};

/** Shows a turn inside its scroller, at once or gliding, and never moves the page. */
const showIn = (
  scroller: HTMLElement,
  element: HTMLElement,
  glide: boolean
) => {
  const box = scroller.getBoundingClientRect();
  const own = element.getBoundingClientRect();
  if (own.top >= box.top && own.bottom <= box.bottom) {
    return;
  }
  // The turn at the top, under the top's fade (the scroller's scroll padding), its speaker first:
  // centred, it opened on the tail of the turn before, with no speaker (eyes-b, B3-interview-05).
  const padding = Number(
    getComputedStyle(scroller).scrollPaddingTop.replace("px", "")
  );
  const room = Number.isFinite(padding) ? padding : 0;
  const top = scroller.scrollTop + own.top - box.top - room;
  const still =
    !glide || matchMedia("(prefers-reduced-motion: reduce)").matches;
  scroller.scrollTo({ top, behavior: still ? "instant" : "smooth" });
};

/** Where a turn is reached when only the rows near the view are drawn: by its row, in the virtualiser. */
interface Reach {
  source: RowSource;
  /** The turn's row. */
  row: number;
}

/** How far, in rows, a windowed transcript still glides to a row. */
const GLIDE_ROWS = 40;

/** Scrolls a windowed transcript to a row, at once or gliding; the virtualiser draws it there. */
const showRow = (reach: Reach, glide: boolean) => {
  // A glide only to a row near the ones drawn: across thousands of rows unmeasured, a glide lands
  // late and wide, so a long way is gone at once.
  const near = reach.source
    .placed()
    .some((place) => Math.abs(place.index - reach.row) < GLIDE_ROWS);
  const still =
    !glide || !near || matchMedia("(prefers-reduced-motion: reduce)").matches;
  reach.source.virtual.scrollToIndex(reach.row, {
    align: "center",
    behavior: still ? "auto" : "smooth",
  });
};

/** Shows a turn the search went to: inside the scroller when there is one, else on the page. */
const showFound = (
  scroller: HTMLElement | null,
  root: HTMLElement | null,
  turn: number,
  reach: Reach | null
) => {
  if (reach !== null) {
    showRow(reach, true);
    return;
  }
  const element =
    root?.querySelector<HTMLElement>(`[data-turn="${turn}"]`) ?? null;
  if (element === null) {
    return;
  }
  if (scroller === null) {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollIntoView({
      block: "nearest",
      behavior: still ? "instant" : "smooth",
    });
  } else {
    showIn(scroller, element, true);
  }
};

/** Where the search is: the match it is on, reset to the first when the words change, and the step to it. */
const useSearchPlace = (shared: InterviewValue) => {
  const [at, setAt] = useState(0);
  const [seen, setSeen] = useState(shared.query);
  if (seen !== shared.query) {
    setSeen(shared.query);
    setAt(0);
  }
  const count = shared.matches.length;
  const place = count === 0 ? null : Math.min(at, count - 1);
  const onStep = (by: 1 | -1) => {
    if (count > 0) {
      setAt(((place ?? 0) + by + count) % count);
    }
  };
  return { place, onStep };
};

/** Shows the turn of the match the search is on, by its place, drawn or not. */
const useShowMatch = (
  scroller: HTMLElement | null,
  height: string | undefined,
  turn: number | null,
  source: RowSource | null,
  row: number | null
) => {
  useEffect(() => {
    if (turn !== null) {
      showFound(
        height === undefined ? null : scroller,
        scroller,
        turn,
        source === null || row === null ? null : { source, row }
      );
    }
    // A step to another match in the same turn needs no scroll: that turn is in view already.
  }, [scroller, height, turn, source, row]);
};

/** Keeps the active turn in view inside the scroller, when there is one; windowed, by its row. */
const useKeepInView = (
  scroller: HTMLElement | null,
  active: number | null,
  asked: number,
  source: RowSource | null,
  row: number | null
) => {
  // Whether it has shown a turn before.
  const shown = useRef(false);
  useEffect(() => {
    if (scroller === null || active === null) {
      return;
    }
    if (source !== null && row !== null) {
      showRow({ source, row }, shown.current || asked > 0);
      shown.current = true;
      return;
    }
    const element = scroller.querySelector<HTMLElement>(
      `[data-turn="${active}"]`
    );
    // The first turn shown is shown at once; one asked for, or reached while playing, glides there.
    if (element !== null) {
      showIn(scroller, element, shown.current || asked > 0);
      shown.current = true;
    }
  }, [scroller, active, asked, source, row]);
};

interface SpeakerProps {
  person: InterviewPerson;
}

/** A run's speaker: their portrait or initials and their name, and their role. */
const Speaker = ({ person }: SpeakerProps) => (
  <p data-slot="interview-speaker" {...stylex.props(styles.who)}>
    <span {...stylex.props(styles.chip)}>
      <span
        data-slot="interview-speaker-sign"
        {...stylex.props(styles.sign, tones[person.tone])}
      >
        <Avatar name={person.name} size="xs" decorative>
          <AvatarImage src={person.src} />
          <AvatarFallback />
        </Avatar>
      </span>
      <span {...stylex.props(styles.chipName)}>{person.name}</span>
    </span>
    {hasWords(person.role) && person.role !== person.name ? (
      <span {...stylex.props(styles.role)}>{person.role}</span>
    ) : null}
  </p>
);

/** What a turn needs of its interview: each part on its own, so a turn redraws only when its own change. */
interface TurnShared {
  words: InterviewWords;
  kindOf: InterviewValue["kindOf"];
  /** What a kind's pill shows before its label. */
  kindMark: InterviewKindMark;
  go: InterviewValue["go"];
  /** A press of its time reaches a sound or the page's `onSeek`. */
  seeks: boolean;
  /** How its highlights are marked. */
  look: InterviewHighlightLook;
}

interface WhenProps extends TurnShared {
  turn: InterviewTurn;
  index: number;
  who: string;
  /** Every turn has a time: else the turns are numbered. */
  withTimes: boolean;
  /** This turn holds the stop, so its time button is in the tab order. */
  stop: boolean;
}

/** A turn's time: a button that seeks, plain words, or its number when the transcript has no times. */
const When = ({
  words,
  go,
  seeks,
  turn,
  index,
  who,
  withTimes,
  stop,
}: WhenProps) => {
  if (!withTimes) {
    return (
      <span {...stylex.props(styles.time)}>{words.passage(index + 1)}</span>
    );
  }
  const time = words.clock(turn.startMs ?? 0);
  if (!seeks) {
    return <span {...stylex.props(styles.time)}>{time}</span>;
  }
  return (
    <span {...stylex.props(styles.time)}>
      <button
        type="button"
        data-slot="interview-seek"
        tabIndex={stop ? 0 : -1}
        aria-label={words.seek(time, who)}
        onClick={() => {
          go(index);
        }}
        {...stylex.props(styles.seek, focus.ring)}
      >
        <span aria-hidden="true" {...stylex.props(styles.reach)} />
        {time}
      </button>
    </span>
  );
};

interface FoundProps {
  piece: Piece;
  /** The matches in its turn, or nothing when nothing is searched for. */
  found: readonly InterviewMatch[] | undefined;
  /** The match the search is on, by its place among all, when it is in this turn. */
  current: number | null;
}

/** A piece's words with the matches in them marked: a line round each, and the current one filled. */
const Found = ({ piece, found, current }: FoundProps) => {
  if (found === undefined) {
    return piece.text;
  }
  return foundPiecesOf(
    piece.text,
    0,
    piece.text.length,
    found.map((match) => ({
      ...match,
      start: match.start - piece.at,
      end: match.end - piece.at,
    }))
  ).map((part) =>
    part.match === undefined ? (
      <Fragment key={part.at}>{part.text}</Fragment>
    ) : (
      <mark
        key={part.at}
        data-slot="interview-found"
        data-current={part.match.index === current ? "" : undefined}
        {...stylex.props(
          styles.found,
          part.match.index === current && styles.foundCurrent
        )}
      >
        {part.text}
      </mark>
    )
  );
};

/** The word joiner (U+2060): it holds the pill to the word before it, and is neither seen nor said. */
const JOIN = "\u2060";

/** The anchor name of a turn's highlight, by its place among the turn's highlights. */
const anchorOf = (at: number) => `--interview-highlight-${at}`;

/** The anchor name of a turn's word in the margin, by its place. */
const noteOf = (at: number) => `--interview-note-${at}`;

interface WordsProps extends FoundProps {
  kindOf: InterviewValue["kindOf"];
  kindMark: InterviewKindMark;
  look: InterviewHighlightLook;
  /** Its place among its turn's highlights, for the margin's rule. */
  at: number;
}

/** A piece of a turn: plain words, or a highlight with its kind written after it. */
const Words = ({
  piece,
  kindOf,
  kindMark,
  look,
  at,
  found,
  current,
}: WordsProps) => {
  if (piece.mark === undefined) {
    return <Found piece={piece} found={found} current={current} />;
  }
  const kind = kindOf(piece.mark.highlight.kind);
  const margin = look === "margin";
  return (
    <>
      <mark
        data-slot="interview-highlight"
        data-kind={piece.mark.highlight.kind}
        data-look={look}
        {...stylex.props(
          styles.mark,
          margin
            ? [styles.marginMark, marginStyles.anchor(anchorOf(at))]
            : styles.underline
        )}
      >
        <Found piece={piece} found={found} current={current} />
      </mark>
      {piece.tail === undefined ? null : (
        <Found piece={piece.tail} found={found} current={current} />
      )}
      <span
        data-slot="interview-kind"
        {...stylex.props(styles.kind, margin && styles.kindSaid)}
      >
        {/* A word joiner: no line breaks between the passage's last word and its pill. */}
        {JOIN}
        <KindPill tone={kind.tone} icon={kind.icon} mark={kindMark}>
          {kind.label}
        </KindPill>
      </span>
    </>
  );
};

interface NotesProps {
  marks: readonly PlacedHighlight[];
  kindOf: InterviewValue["kindOf"];
  kindMark: InterviewKindMark;
}

/** Margin: a rule beside each highlight's lines, and its kind's pill at the rule's head. Seen, not said: the words say it. */
const Notes = ({ marks, kindOf, kindMark }: NotesProps) =>
  marks.map((mark, at) => {
    const kind = kindOf(mark.highlight.kind);
    return (
      <Fragment key={mark.highlight.id}>
        <MarginRule
          anchor={anchorOf(at)}
          slot="interview-rule"
          look={styles.ruleLit}
        />
        <span
          aria-hidden="true"
          data-slot="interview-note"
          {...stylex.props(
            styles.note,
            marginStyles.placed(anchorOf(at)),
            marginStyles.anchor(noteOf(at)),
            at > 0 && marginStyles.below(noteOf(at - 1))
          )}
        >
          <KindPill tone={kind.tone} icon={kind.icon} mark={kindMark}>
            {kind.label}
          </KindPill>
        </span>
      </Fragment>
    );
  });

interface TurnProps extends TurnShared {
  turn: InterviewTurn;
  index: number;
  person: InterviewPerson;
  /** Its highlights, placed. */
  marks: readonly PlacedHighlight[] | undefined;
  /** It is the active turn. */
  active: boolean;
  /** It starts a run: its speaker's chip is drawn above it. */
  runStart: boolean;
  withTimes: boolean;
  stop: boolean;
  /** The matches of the words searched for in it, or nothing. */
  found: readonly InterviewMatch[] | undefined;
  /** The match the search is on, when it is in this turn; else null. */
  current: number | null;
  /** Windowed: its row's place in the whole table, from 1, for a screen reader. */
  rowIndex?: number;
  /** Windowed: measures its row for the virtualiser. */
  measure?: (element: HTMLTableRowElement | null) => () => void;
  /** Drawn always, not only near the view: windowed (measured as it is), or a short transcript. */
  drawn: boolean;
}

/** One turn: its time, its speaker when a run starts, and its words with their highlights. */
const Turn = ({
  turn,
  index,
  person,
  marks,
  active,
  runStart,
  withTimes,
  stop,
  found,
  current,
  rowIndex,
  measure,
  drawn,
  ...shared
}: TurnProps) => (
  <tr
    ref={measure}
    aria-rowindex={rowIndex}
    data-turn={index}
    data-slot="interview-turn"
    tabIndex={stop ? 0 : -1}
    aria-current={active ? "true" : undefined}
    {...stylex.props(
      styles.turn,
      turnMarker,
      shared.look === "margin" && styles.turnMargin,
      runStart && styles.runStart,
      drawn && styles.drawn,
      active && styles.active,
      focus.inside
    )}
  >
    <td {...stylex.props(styles.timeCell)}>
      <When
        {...shared}
        turn={turn}
        index={index}
        who={person.name}
        withTimes={withTimes}
        stop={stop}
      />
    </td>
    <td {...stylex.props(styles.cell)}>
      {runStart ? <Speaker person={person} /> : null}
      <p {...stylex.props(styles.words)}>
        {piecesOf(turn.text, marks).map((piece) => (
          <Words
            key={piece.at}
            piece={piece}
            kindOf={shared.kindOf}
            kindMark={shared.kindMark}
            look={shared.look}
            at={
              piece.mark === undefined || marks === undefined
                ? 0
                : marks.indexOf(piece.mark)
            }
            found={found}
            current={current}
          />
        ))}
      </p>
      {shared.look === "margin" && marks !== undefined ? (
        <Notes
          marks={marks}
          kindOf={shared.kindOf}
          kindMark={shared.kindMark}
        />
      ) : null}
    </td>
  </tr>
);

/** A speaker the list leaves out, shown by the key the turn uses. */
const personFor = (
  people: InterviewValue["people"],
  key: string
): InterviewPerson => people.get(key) ?? { key, name: key, tone: "neutral" };

interface BodyProps {
  shared: InterviewValue;
  height: string | undefined;
  level: 2 | 3 | 4 | 5 | 6;
  layout: InterviewLayoutStyle | undefined;
  look: InterviewHighlightLook;
}

/** What every row needs to draw a turn: the interview, the stop and the match the search is on. */
interface Drawing {
  shared: InterviewValue;
  level: 2 | 3 | 4 | 5 | 6;
  stop: number;
  withTimes: boolean;
  currentMatch: InterviewMatch | undefined;
  look: InterviewHighlightLook;
}

/**
 * A transcript this short is drawn whole: a turn's room before it is drawn can only be guessed,
 * and a wrong guess (a narrow column wraps more) moves the page as the stage comes into view.
 * Longer, each turn is drawn only near the view, and holds a guess of its room until then.
 */
const WHOLE_UP_TO = 40;

/** A turn's row, by its place; windowed, with its place in the table and its measure. */
const drawTurn = (
  { shared, stop, withTimes, currentMatch, look }: Drawing,
  index: number,
  runStart: boolean,
  rowIndex?: number,
  measure?: TurnProps["measure"]
) => {
  const turn = shared.turns[index];
  return turn === undefined ? null : (
    <Turn
      key={keyOf(turn, index)}
      turn={turn}
      index={index}
      person={personFor(shared.people, turn.speaker)}
      marks={shared.marks.get(index)}
      active={shared.active === index}
      runStart={runStart}
      withTimes={withTimes}
      stop={stop === index}
      found={shared.matchesIn.get(index)}
      current={currentMatch?.turn === index ? currentMatch.index : null}
      rowIndex={rowIndex}
      measure={measure}
      drawn={measure !== undefined || shared.turns.length <= WHOLE_UP_TO}
      words={shared.words}
      kindOf={shared.kindOf}
      kindMark={shared.kindMark}
      go={shared.go}
      seeks={shared.seeks}
      look={look}
    />
  );
};

/** The kinds present, each with how many highlights it has: the most first, then as `kinds` lists them. */
const kindCountsOf = (shared: InterviewValue) => {
  const counts = new Map<
    string,
    { kind: ReturnType<InterviewValue["kindOf"]>; count: number }
  >();
  for (const placed of [...shared.marks.values()].flat()) {
    const kind = shared.kindOf(placed.highlight.kind);
    counts.set(kind.label, {
      kind,
      count: (counts.get(kind.label)?.count ?? 0) + 1,
    });
  }
  return [...counts.values()].toSorted((a, b) => b.count - a.count);
};

/** Margin: the kinds present, counted, in one quiet line above the turns; only with two highlights or more, as one needs no count. */
const KindsLegend = ({ shared }: { shared: InterviewValue }) => {
  const counts = kindCountsOf(shared);
  if (counts.reduce((sum, each) => sum + each.count, 0) < 2) {
    return null;
  }
  return (
    <ul
      data-slot="interview-kinds"
      aria-label={shared.words.kinds}
      {...stylex.props(styles.legend)}
    >
      {counts.map(({ kind, count }) => (
        <li key={kind.label} {...stylex.props(styles.legendItem)}>
          <KindPill tone={kind.tone} icon={kind.icon} mark={shared.kindMark}>
            {shared.words.kindCount(kind.label, count)}
          </KindPill>
        </li>
      ))}
    </ul>
  );
};

interface HeadingProps {
  title: string;
  first: boolean;
  level: 2 | 3 | 4 | 5 | 6;
  rowIndex?: number;
  measure?: (element: HTMLTableRowElement | null) => () => void;
}

/** A chapter's heading, as a row of the table. */
const Heading = ({ title, first, level, rowIndex, measure }: HeadingProps) => (
  <tr
    ref={measure}
    aria-rowindex={rowIndex}
    {...stylex.props(styles.headingRow)}
  >
    <th colSpan={2} {...stylex.props(styles.headingCell)}>
      {createElement(
        `h${level}`,
        stylex.props(styles.heading, first && styles.headingFirst),
        title
      )}
    </th>
  </tr>
);

/** Every turn, in a body per chapter: a transcript that is not windowed. */
const AllRows = ({ drawing }: { drawing: Drawing }) =>
  groupsOf(drawing.shared.turns.length, drawing.shared.chapters).map(
    (group, at) => (
      <tbody key={group.from} {...stylex.props(styles.chapter)}>
        {group.chapter === undefined ? null : (
          <Heading
            title={group.chapter.title}
            first={at === 0}
            level={drawing.level}
          />
        )}
        {Array.from({ length: group.to - group.from + 1 }, (_, offset) => {
          const index = group.from + offset;
          return drawTurn(
            drawing,
            index,
            index === group.from ||
              drawing.shared.turns[index - 1]?.speaker !==
                drawing.shared.turns[index]?.speaker
          );
        })}
      </tbody>
    )
  );

/** One row of a windowed transcript, with its place in the table and its measure. */
const drawRow = (
  drawing: Drawing,
  row: TranscriptRow,
  at: number,
  measure?: TurnProps["measure"]
) =>
  row.kind === "chapter" ? (
    <Heading
      key={row.key}
      title={row.chapter.title}
      first={row.first}
      level={drawing.level}
      rowIndex={at + 1}
      measure={measure}
    />
  ) : (
    drawTurn(drawing, row.index, row.runStart, at + 1, measure)
  );

interface WindowedProps {
  drawing: Drawing;
  rows: readonly TranscriptRow[];
  source: RowSource;
  /** The virtualiser has its scroller: the rows near the view, else the first rows in flow. */
  mounted: boolean;
  /** Where the first rows start before it is mounted: at the active turn's row, or the first. */
  from: number;
}

/**
 * The rows near the view, between two spacers that hold the room of the rest, in flow: the rows
 * drawn at first stand where the virtualiser then places them, so nothing moves when it comes alive.
 */
const WindowedRows = ({
  drawing,
  rows,
  source,
  mounted,
  from,
}: WindowedProps) => {
  const placed = useSyncExternalStore(
    source.subscribe,
    source.placed,
    source.placed
  );
  const size = useSyncExternalStore(source.subscribe, source.size, source.size);
  // Before it is mounted (on the server, and with JavaScript off): the first rows, where the
  // transcript opens, between the same two spacers, so each row keeps its element after.
  const shown = mounted
    ? placed.map((place) => ({
        at: place.index,
        measure: (element: HTMLTableRowElement | null) =>
          source.virtual.measure(place.index, element),
      }))
    : rows
        .slice(from, from + FIRST_ROWS)
        .map((_, offset) => ({ at: from + offset, measure: undefined }));
  const [first] = placed;
  const last = placed.at(-1);
  const above = mounted ? (first?.start ?? 0) : 0;
  const below =
    mounted && last !== undefined
      ? Math.max(0, size - last.start - last.size)
      : 0;
  return (
    <tbody {...stylex.props(styles.chapter)}>
      <tr
        aria-hidden="true"
        data-slot="interview-spacer"
        {...stylex.props(styles.spacer, styles.height(`${above}px`))}
      />
      {shown.map(({ at, measure }) => {
        const row = rows[at];
        return row === undefined ? null : drawRow(drawing, row, at, measure);
      })}
      <tr
        aria-hidden="true"
        data-slot="interview-spacer"
        {...stylex.props(styles.spacer, styles.height(`${below}px`))}
      />
    </tbody>
  );
};

// False on the server and while hydrating, true after: a store that never changes.
const never = () => () => {
  // Nothing to stop listening to.
};
const inBrowser = () => true;
const onServer = () => false;

/**
 * The virtualiser, handed its scroller while the transcript is windowed, and whether it has it:
 * never on the server or while hydrating, so the first rows drawn there are the first rows here.
 * A transcript of another length is a new one: its virtualiser is made again, with nothing measured.
 */
const useWindow = (
  scroller: HTMLElement | null,
  windowed: boolean,
  rows: TranscriptRow[]
) => {
  const [made, setMade] = useState(() => ({
    count: rows.length,
    source: createRowSource(rows),
  }));
  if (made.count !== rows.length) {
    setMade({ count: rows.length, source: createRowSource(rows) });
  }
  const { source } = made;
  const live = useSyncExternalStore(never, inBrowser, onServer);
  // The virtualiser reads the rows during render, so it is handed this render's rows first.
  source.show(rows);
  useLayoutEffect(
    () =>
      windowed && scroller !== null
        ? source.virtual.connect(scroller)
        : undefined,
    [source, windowed, scroller]
  );
  // New turns or chapters: the virtualiser reads its rows again.
  useLayoutEffect(() => {
    source.show(rows);
    source.virtual.refresh();
  }, [source, rows]);
  return { source, mounted: windowed && live && scroller !== null };
};

/** Whether the transcript is windowed, its rows, and the virtualiser that places them. */
const useTranscriptWindow = (
  shared: InterviewValue,
  height: string | undefined,
  scroller: HTMLElement | null
) => {
  // Past `windowFrom` turns, with its own scroller, only the rows near the view are drawn.
  const windowed =
    height !== undefined &&
    shared.windowFrom !== null &&
    shared.turns.length > shared.windowFrom;
  const { rows, turnRow } = rowsOf(shared.turns, shared.chapters);
  const { source, mounted } = useWindow(scroller, windowed, rows);
  /** A turn's row, or null for none. */
  const rowOf = (turn: number | null | undefined) =>
    turn === null || turn === undefined ? null : (turnRow[turn] ?? null);
  return {
    windowed,
    rows,
    turnRow,
    source,
    mounted,
    reach: mounted ? source : null,
    rowOf,
  };
};

/** A turn the keys moved the stop to, focused once its row is drawn. */
const useFocusWhenDrawn = (
  scroller: HTMLElement | null,
  wanted: number | null,
  done: () => void
) => {
  useEffect(() => {
    const element =
      wanted === null
        ? null
        : (scroller?.querySelector<HTMLElement>(`[data-turn="${wanted}"]`) ??
          null);
    if (element !== null) {
      element.focus({ preventScroll: true });
      done();
    }
  });
};

/** The keys, focus and blur of the turns: one roving stop, moved by the arrows, Page Up and Down, Home and End. */
const useTurnKeys = (
  shared: InterviewValue,
  source: RowSource,
  windowed: boolean,
  turnRow: readonly number[],
  setFocused: (turn: number | null) => void
) => {
  const [wanted, setWanted] = useState<number | null>(null);
  const count = shared.turns.length;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const found = turnIn(event.target);
    if (found === null || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const to = moveFor(event.key, found.at, count);
    if (to !== null) {
      event.preventDefault();
      setFocused(to);
      const element = event.currentTarget.querySelector<HTMLElement>(
        `[data-turn="${to}"]`
      );
      if (!windowed) {
        element?.focus();
        return;
      }
      // Drawn or not, the virtualiser scrolls to its row; it takes focus once it is there.
      source.keep(turnRow[to] ?? null);
      source.virtual.scrollToIndex(turnRow[to] ?? 0, { align: "auto" });
      if (element === null) {
        setWanted(to);
      } else {
        element.focus({ preventScroll: true });
      }
    } else if (
      event.target === found.element &&
      (event.key === "Enter" || event.key === " ")
    ) {
      event.preventDefault();
      shared.go(found.at);
    }
  };
  const onFocus = (event: FocusEvent<HTMLElement>) => {
    const found = turnIn(event.target);
    if (found !== null) {
      setFocused(found.at);
      source.keep(turnRow[found.at] ?? null);
    }
  };
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (
      !(
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      )
    ) {
      setFocused(null);
      source.keep(null);
    }
  };
  const done = () => {
    setWanted(null);
  };
  return { wanted, done, onKeyDown, onFocus, onBlur };
};

// ---- The margin, proven before it is shown ---------------------------------------------------------
//
// The table starts as `underline` draws it, the rules laid out but unseen, and is measured once laid
// out (margin.tsx, proveMargin): placed right, it says `data-margin="placed"` and the margin shows;
// not, it says `data-margin="off"` and stays underlined for good.

const proveTable = proveMargin({
  mark: "[data-slot=interview-highlight][data-look=margin]",
  rule: "[data-slot=interview-rule]",
  note: "[data-slot=interview-note]",
  group: "[data-slot=interview-turn]",
  after: "[data-slot=interview-kind]",
  // Narrow, no rule is drawn: nothing to judge until the transcript is wide.
  skipUndrawn: true,
});

interface ColumnProps {
  shared: InterviewValue;
  look: InterviewHighlightLook;
  lang: string | undefined;
  wording: ReturnType<typeof langOf>["words"];
  layout: InterviewLayoutStyle | undefined;
  place: number | null;
  onStep: (by: 1 | -1) => void;
  children: ReactNode;
}

/** The transcript under its search field, or under the margin's kinds, or both. */
const Column = ({
  shared,
  look,
  lang,
  wording,
  layout,
  place,
  onStep,
  children,
}: ColumnProps) => (
  <div
    data-slot={
      shared.search
        ? "interview-transcript-search"
        : "interview-transcript-column"
    }
    lang={lang}
    {...stylex.props(styles.searching, wording, layout)}
  >
    {shared.search ? (
      <TranscriptSearch shared={shared} place={place} onStep={onStep} />
    ) : null}
    {look === "margin" ? <KindsLegend shared={shared} /> : null}
    {children}
  </div>
);

/** Marks the edges with turns past them, for the fades: an attribute, so nothing renders again. */
const markEdges = (element: HTMLElement) => {
  const room = element.scrollHeight - element.clientHeight;
  element.toggleAttribute(
    "data-under-start",
    room > 1 && element.scrollTop > 1
  );
  element.toggleAttribute(
    "data-under-end",
    room > 1 && element.scrollTop < room - 1
  );
};

/** Marks the edges now, as it scrolls and as it or its rows change size; returns what stops it. */
const watchEdges = (element: HTMLElement) => {
  const mark = () => {
    markEdges(element);
  };
  mark();
  element.addEventListener("scroll", mark, { passive: true });
  const observer = new ResizeObserver(mark);
  observer.observe(element);
  const rows = element.firstElementChild;
  if (rows !== null) {
    observer.observe(rows);
  }
  return () => {
    element.removeEventListener("scroll", mark);
    observer.disconnect();
  };
};

/** The transcript inside its interview. */
const Body = ({ shared, height, level, layout, look }: BodyProps) => {
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  // The turn that had focus last, while focus is inside; null hands the stop back to the active turn.
  const [focused, setFocused] = useState<number | null>(null);
  const { turns } = shared;
  const count = turns.length;
  const stop = Math.min(focused ?? shared.active ?? 0, Math.max(count - 1, 0));
  const { lang, words: wording } = langOf(undefined, shared.lang);
  const { windowed, rows, turnRow, source, mounted, reach, rowOf } =
    useTranscriptWindow(shared, height, scroller);
  const activeRow = rowOf(shared.active);
  useKeepInView(
    height === undefined ? null : scroller,
    shared.active,
    shared.asked,
    reach,
    activeRow
  );
  const { place, onStep } = useSearchPlace(shared);
  const currentMatch = place === null ? undefined : shared.matches[place];
  useShowMatch(
    scroller,
    height,
    currentMatch?.turn ?? null,
    reach,
    rowOf(currentMatch?.turn)
  );
  const { wanted, done, onKeyDown, onFocus, onBlur } = useTurnKeys(
    shared,
    source,
    windowed,
    turnRow,
    setFocused
  );
  useFocusWhenDrawn(scroller, wanted, done);
  const drawing: Drawing = {
    shared,
    level,
    stop,
    withTimes: timed(turns),
    currentMatch,
    look,
  };
  // With a search field or the margin's kinds above it, the transcript stands in a column with them.
  const wrapped = shared.search || look === "margin";
  // Its own scroller fades an edge with turns past it (eyes-b, B3-interview-01).
  useEffect(
    () =>
      scroller !== null && height !== undefined
        ? watchEdges(scroller)
        : undefined,
    [scroller, height]
  );

  const transcript = (
    <div
      ref={setScroller}
      data-slot="interview-transcript"
      lang={lang}
      {...stylex.props(
        styles.root,
        wording,
        height !== undefined && styles.scroller,
        height !== undefined && styles.height(height),
        height !== undefined && scroll.bar,
        !wrapped && layout
      )}
    >
      {/* The keys are heard here, from the turns and their time buttons inside it. */}
      <div
        role="presentation"
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        <table
          ref={look === "margin" ? proveTable : undefined}
          aria-label={shared.words.transcript}
          aria-rowcount={windowed ? rows.length : undefined}
          {...stylex.props(styles.table, marginMarker)}
        >
          {windowed ? (
            <WindowedRows
              drawing={drawing}
              rows={rows}
              source={source}
              mounted={mounted}
              from={
                activeRow === null || activeRow < FIRST_ROWS ? 0 : activeRow
              }
            />
          ) : (
            <AllRows drawing={drawing} />
          )}
        </table>
      </div>
    </div>
  );
  if (!wrapped) {
    return transcript;
  }
  return (
    <Column
      shared={shared}
      look={look}
      lang={lang}
      wording={wording}
      layout={layout}
      place={place}
      onStep={onStep}
    >
      {transcript}
    </Column>
  );
};

/** The conversation, turn by turn. Inside an Interview it shows that one; alone, the one its props give. */
export const InterviewTranscript = ({
  height,
  level: levelDeprecated,
  headingLevel: level = levelDeprecated ?? 4,
  highlightLook,
  style: styleProp,
  layout,
  ...data
}: InterviewTranscriptProps) => {
  const shared = useInterview();
  if (shared === null) {
    return (
      <Interview {...data}>
        <InterviewTranscript
          height={height}
          level={level}
          highlightLook={highlightLook}
          layout={layout ?? styleProp}
        />
      </Interview>
    );
  }
  return (
    <Body
      shared={shared}
      height={height}
      level={level}
      look={highlightLook ?? shared.highlightLook}
      layout={layout ?? styleProp}
    />
  );
};
