// The look of sources and citations, shared by their parts. Every value is a token (src/tokens).
import * as stylex from "@stylexjs/stylex";

import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { pileMarker, pileVars } from "./markers.stylex";

const HOVER = media.hover;
const FORCED = media.forced;
const COARSE = media.coarse;
const REDUCED = media.reduced;

// The newest mark arriving in the pile, and the light crossing it once.
const arrive = stylex.keyframes({
  from: { opacity: 0, transform: "translateX(-6px) scale(0.92)" },
  to: { opacity: 1, transform: "none" },
});
const cross = stylex.keyframes({
  from: { transform: "translateX(-110%)" },
  to: { transform: "translateX(110%)" },
});

export const sourceStyles = stylex.create({
  // ---- The marker -----------------------------------------------------------------------------
  // Plain inline boxes: an inline-flex box can drop to the next line alone; inline, the word joiner
  // before it holds and the marker stays with the word it backs. A number stands half a step from
  // its word; a chip, which starts with a mark, a whole step (the chips' own styles).
  marker: {
    position: "relative",
    display: "inline",
    whiteSpace: "nowrap",
    marginInlineStart: `calc(${grasp.space1} / 2)`,
    borderRadius: grasp.cornerMark,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    fontWeight: grasp.weightMedium,
    textDecoration: "none",
    cursor: "pointer",
    // Its edge or fill is gone in forced colours: a real line there.
    outlineOffset: 0,
    transitionProperty: "background-color, color, box-shadow",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  // The number, A: a small box on the soft fill.
  numberBox: {
    paddingInline: grasp.space1,
    paddingBlock: 1,
    lineHeight: grasp.textXsLine,
    fontVariantNumeric: "tabular-nums",
    color: {
      default: grasp.muted,
      ":hover": { default: null, [HOVER]: grasp.ink },
    },
    backgroundColor: {
      default: grasp.soft,
      ":hover": { default: null, [HOVER]: grasp.itemFillHighlight },
    },
    boxShadow: grasp.edge,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
  },
  // Lit with its row: the pointer is on it or on its row, or it has focus.
  markerLit: {
    color: { default: grasp.ink, [FORCED]: "HighlightText" },
    backgroundColor: {
      default: grasp.itemFillHighlight,
      [FORCED]: "Highlight",
    },
  },
  // A finger needs 44px: an unseen area round the marker, on a touch screen.
  markerTarget: {
    position: "absolute",
    inset: { default: 0, [COARSE]: `calc((1em - ${grasp.tap}) / 2)` },
    minWidth: { default: 0, [COARSE]: grasp.tap },
  },

  // ---- The words a marker backs -------------------------------------------------------------------
  claim: {
    borderRadius: 3,
    boxDecorationBreak: "clone",
    textDecorationLine: "underline",
    textDecorationThickness: 2,
    textUnderlineOffset: 4,
    textDecorationColor: "transparent",
    backgroundColor: "transparent",
    transitionProperty: "background-color, text-decoration-color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  claimWash: {
    backgroundColor: { default: grasp.sourceClaimWash, [FORCED]: "Highlight" },
    color: { default: null, [FORCED]: "HighlightText" },
  },

  // ---- A source's mark on its tile ----------------------------------------------------------------
  tile: {
    position: "relative",
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    boxSizing: "border-box",
    borderRadius: grasp.cornerMark,
    cornerShape: grasp.cornerShape,
    color: grasp.text,
    backgroundColor: grasp.raised,
    boxShadow: grasp.edge,
    outline: {
      default: "none",
      [FORCED]: `${grasp.hairline} solid CanvasText`,
    },
    outlineOffset: `calc(-1 * ${grasp.hairline})`,
  },
  tileRow: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    width: grasp.controlSm,
    height: grasp.controlSm,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 3))`,
  },
  tilePile: {
    [iconVars.size]: grasp.sourceMarkInline,
    [iconVars.stroke]: grasp.iconStroke,
    width: grasp.sourcePileMark,
    height: grasp.sourcePileMark,
  },
  tileRound: { borderRadius: "50%" },
  // Locked or gone: the mark stays, quieter.
  tileQuiet: { color: grasp.quiet, opacity: 0.72 },
  // An agent or a workflow: our mint, in the chosen form.
  runTint: {
    color: grasp.mintDeep,
    backgroundColor: grasp.sourceAgentTint,
    boxShadow: `inset 0 0 0 ${grasp.hairline} color-mix(in oklch, ${grasp.mintDeep} 22%, transparent)`,
  },
  // A portrait fills its tile.
  portrait: {
    display: "block",
    width: "100%",
    height: "100%",
    objectFit: "cover",
    borderRadius: "inherit",
  },
  favicon: {
    display: "block",
    width: grasp.iconSm,
    height: grasp.iconSm,
    objectFit: "contain",
  },
  // A message's sender, small, on the corner of the app's tile.
  sender: {
    position: "absolute",
    insetInlineEnd: -4,
    insetBlockEnd: -4,
    width: 16,
    height: 16,
    overflow: "hidden",
    borderRadius: "50%",
    boxShadow: `0 0 0 2px ${grasp.raised}`,
  },

  // ---- The list -----------------------------------------------------------------------------------
  section: {
    display: "grid",
    gap: grasp.space2,
    minWidth: 0,
    fontFamily: grasp.fontSans,
  },
  head: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space2,
  },
  heading: {
    margin: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    color: grasp.muted,
  },
  list: {
    display: "grid",
    rowGap: grasp.space1,
    minWidth: 0,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  group: { display: "grid", gap: grasp.space1, minWidth: 0 },
  groupName: {
    margin: 0,
    paddingInline: grasp.space2,
    paddingBlockStart: grasp.space2,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    color: grasp.muted,
  },
  // One row for every kind: the mark, the title with its number, where and when, the part used.
  row: {
    position: "relative",
    display: "grid",
    gridTemplateColumns: `${grasp.controlSm} minmax(0, 1fr)`,
    alignItems: "start",
    columnGap: grasp.space3,
    minHeight: { default: grasp.controlLg, [COARSE]: grasp.tap },
    boxSizing: "border-box",
    paddingBlock: grasp.space2,
    paddingInline: grasp.space2,
    // The row's room hangs out past the column, so its tile starts at the paragraph's edge and
    // the hover fill still has room round it (eyes-b, B3-sources-04: the tiles stood 8px in).
    marginInline: `calc(-1 * ${grasp.space2})`,
    borderRadius: `min(${grasp.corner}, ${grasp.space3})`,
    cornerShape: grasp.cornerShape,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: grasp.itemFillHighlight },
    },
    transitionProperty: "background-color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
    scrollMarginBlock: grasp.space6,
  },
  rowLit: {
    backgroundColor: {
      default: grasp.itemFillHighlight,
      [FORCED]: "Highlight",
    },
  },
  // A row a marker sent focus to (one that is not a link: locked, gone) lights the same way.
  rowHeld: {
    backgroundColor: {
      default: null,
      ":focus": { default: grasp.itemFillHighlight, [FORCED]: "Highlight" },
    },
  },
  words: { display: "grid", minWidth: 0, rowGap: 2 },
  // The title, then its number straight after its last word, also when the title wraps.
  titleLine: { display: "block", minWidth: 0 },
  title: {
    minWidth: 0,
    // The ring round a focused title takes the small corner, as every ring round words does.
    borderRadius: grasp.cornerMark,
    // Its own run of words: what follows it (a lock, its number) keeps the line's direction, so
    // in a right-to-left page they stand at the title's left, mirrored.
    unicodeBidi: "isolate",
    color: grasp.ink,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    textDecoration: "none",
    overflowWrap: "anywhere",
  },
  titleQuiet: { color: grasp.muted },
  // A title that opens through the page's onOpen, with nowhere to go: a button, drawn as the link.
  titleButton: {
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    fontFamily: "inherit",
    letterSpacing: "inherit",
    textAlign: "start",
    cursor: "pointer",
  },
  number: {
    unicodeBidi: "isolate",
    marginInlineStart: grasp.space2,
    whiteSpace: "nowrap",
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontVariantNumeric: "tabular-nums",
    color: grasp.quiet,
  },
  lock: {
    [iconVars.size]: grasp.sourceMarkInline,
    display: "inline-flex",
    marginInlineStart: grasp.space2,
    verticalAlign: "-2px",
    color: grasp.muted,
  },
  where: {
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    overflowWrap: "anywhere",
  },
  fresh: { color: grasp.mintDeep, fontWeight: grasp.weightMedium },
  gone: { color: grasp.danger },
  used: {
    margin: 0,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.text,
    overflowWrap: "anywhere",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  // The row's link covers the row, so the whole row opens the source.
  stretch: { position: "absolute", inset: 0, borderRadius: "inherit" },
  more: { justifySelf: "start" },

  // ---- The pile -----------------------------------------------------------------------------------
  // Its own width, not the column's: stretched, its hover fill ran far past the count. At its end
  // it keeps the room the fan takes (unseen at rest, where it has no fill), so open the room is
  // space-3 all round: before the first mark, between the last and the count, after the count.
  // That room before the first mark hangs outside the column, so at rest the first mark shares the
  // column's start edge with the words above and below it (eyes-b, B-sources-04); only the hover
  // fill reaches past it.
  pile: {
    display: "inline-flex",
    justifySelf: "start",
    marginInlineStart: `calc(-1 * ${grasp.space3})`,
    alignItems: "center",
    gap: grasp.space3,
    maxWidth: "100%",
    minHeight: grasp.tap,
    paddingInlineStart: grasp.space3,
    paddingInlineEnd: `calc(${grasp.space3} + ${pileVars.spread} * ${grasp.sourcePileFan})`,
    paddingBlock: grasp.space1,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    fontFamily: grasp.fontSans,
    color: grasp.text,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: grasp.ghostFillHover },
    },
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  pileMarks: {
    display: "inline-flex",
    alignItems: "center",
    paddingInlineStart: grasp.sourcePileOverlap,
  },
  // Under a pointer the count steps aside as far as the last mark, so the room between them holds.
  pileCount: {
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
    transform: {
      default: "none",
      [stylex.when.ancestor(":hover", pileMarker)]: {
        default: null,
        [HOVER]: `translateX(calc(${pileVars.spread} * ${grasp.sourcePileFan}))`,
      },
      // Keyboard focus fans it too: the ring is drawn round the room the fan takes, so a folded
      // pile left that room empty on one side (eyes-b, B3-sources-02).
      [stylex.when.ancestor(":focus-visible", pileMarker)]:
        `translateX(calc(${pileVars.spread} * ${grasp.sourcePileFan}))`,
    },
    transitionProperty: "transform",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  // The kinds in words: on the column's start edge with the first mark. Each kind keeps its number
  // ("1 code file" never splits), and the lines are balanced, so no word stands alone on a line.
  pileKinds: {
    margin: 0,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    textWrap: "balance",
  },
  pileKind: { whiteSpace: "nowrap" },
  pileMark: {
    position: "relative",
    display: "inline-grid",
    marginInlineStart: `calc(-1 * ${grasp.sourcePileOverlap})`,
    overflow: "hidden",
    borderRadius: grasp.cornerMark,
    cornerShape: grasp.cornerShape,
    // The system's edge alone: a ring in the page's colour would show as a white block on any
    // other ground, and on the pile's hover fill.
    boxShadow: grasp.edge,
    // The fan, by transform alone so nothing in the row moves: from the first mark, which stays,
    // each moves its place in steps. Only where a pointer hovers.
    transform: {
      default: "none",
      [stylex.when.ancestor(":hover", pileMarker)]: {
        default: null,
        [HOVER]: `translateX(calc(${pileVars.at} * ${grasp.sourcePileFan}))`,
      },
      [stylex.when.ancestor(":focus-visible", pileMarker)]:
        `translateX(calc(${pileVars.at} * ${grasp.sourcePileFan}))`,
    },
    transitionProperty: "transform",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  pileMarkRun: { boxShadow: `${grasp.edge}, ${grasp.liftLow}` },
  // The newest mark found while the answer streams: it settles in, and our light crosses it once.
  arrived: {
    animationName: { default: arrive, [REDUCED]: "none" },
    animationDuration: grasp.durationUi,
    animationTimingFunction: grasp.ease,
    // Backwards only: once in, the mark's own transform (its fan) is its own again.
    animationFillMode: "backwards",
  },
  light: {
    position: "absolute",
    inset: 0,
    backgroundImage: grasp.sourceLight,
    transform: "translateX(-110%)",
    animationName: { default: cross, [REDUCED]: "none" },
    animationDuration: grasp.sourceLightCross,
    animationDelay: grasp.durationHover,
    animationTimingFunction: grasp.easeInOut,
    animationFillMode: "both",
    pointerEvents: "none",
  },

  // ---- The card -----------------------------------------------------------------------------------
  // The card's ground, laid on Hover card's panel (the raised fill, the edge's lift, a real border
  // in forced colours): it opens over the answer's next line, so it never fades in or out, which
  // would let those words show through it. It still grows from the marker and shrinks as it goes.
  cardGround: {
    opacity: 1,
    backgroundColor: { default: grasp.popupFill, [FORCED]: "Canvas" },
  },
  card: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: grasp.space2,
    width: "100%",
    minWidth: 0,
    fontFamily: grasp.fontSans,
  },
  cardHead: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  cardTitle: {
    margin: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  cardQuiet: {
    margin: 0,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.quiet,
  },
  cardNote: {
    margin: 0,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  cardLink: {
    justifySelf: "start",
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  // The passage: Geist Serif, the one thing in focus, with its mint mark.
  passage: {
    margin: 0,
    fontFamily: grasp.fontSerif,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    color: grasp.ink,
    quotes: "none",
    overflowWrap: "anywhere",
  },
  passageBar: {
    paddingInlineStart: grasp.space3,
    borderInlineStartWidth: { default: 2, [FORCED]: grasp.hairline },
    borderInlineStartStyle: "solid",
    borderInlineStartColor: { default: grasp.mint, [FORCED]: "CanvasText" },
  },
  people: { display: "flex", alignItems: "center" },
  person: {
    marginInlineStart: -6,
    borderRadius: "50%",
    boxShadow: `0 0 0 2px ${grasp.popupFill}`,
  },
  personFirst: { marginInlineStart: 0 },
  transcript: {
    display: "grid",
    gap: grasp.space1,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  transcriptLine: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    columnGap: grasp.space2,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  transcriptTime: { fontVariantNumeric: "tabular-nums", color: grasp.quiet },
  transcriptWho: { fontWeight: grasp.weightMedium, color: grasp.text },
  sayer: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  sayerName: { fontWeight: grasp.weightMedium, color: grasp.ink },
});

/** The fan's steps: a mark's place in the pile, and on the pile the last one's (0 for no fan). */
export const fanStyles = stylex.create({
  at: (steps: string) => ({ [pileVars.at]: steps }),
  spread: (steps: string) => ({ [pileVars.spread]: steps }),
});
