// The look of agent activity, shared by its parts: quiet type and the list's measure. The step
// that is working shows the working mark (src/components/working-mark). Every value is a token (src/tokens).
import * as stylex from "@stylexjs/stylex";

import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

const HOVER = media.hover;
const REDUCED = media.reduced;
const FORCED = media.forced;

// A step or a line arriving: it fades in, a little lower first. With reduced motion it is simply there.
const arrive = stylex.keyframes({
  from: { opacity: 0, transform: `translateY(${grasp.space1})` },
  to: { opacity: 1, transform: "none" },
});

export const activityStyles = stylex.create({
  root: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "grid",
    // As wide as its longest line, never wider than the column: long lines wrap there.
    width: "max-content",
    maxWidth: "100%",
    minWidth: 0,
    margin: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
  // The one line: what it is doing now, or what it did. A press opens the steps.
  head: {
    position: "relative",
    // Above the steps, so its 44px press area on a touch screen is not covered by the first one.
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    width: "max-content",
    maxWidth: "100%",
    minHeight: grasp.controlSm,
    boxSizing: "border-box",
    margin: 0,
    // Its words line up with the column's edge; its hover fill reaches past it. An offset, not a
    // margin, so the line's width is measured whole.
    insetInlineStart: `calc(-1 * ${grasp.space2})`,
    paddingInline: grasp.space2,
    paddingBlock: 0,
    borderWidth: 0,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))`,
    cornerShape: grasp.cornerShape,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: grasp.itemFillHighlight },
    },
    color: {
      default: grasp.muted,
      ":hover": { default: null, [HOVER]: grasp.ink },
    },
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    textAlign: "start",
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    transitionProperty: "background-color, color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  headOpen: {
    color: grasp.ink,
  },
  // The line's words. A new step's words simply take the old ones' place, in one frame: a fade
  // from nothing made the line blink empty between steps, and dimming and brightening it reads as
  // more motion than the change it shows.
  headWords: {
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  // The one line while it works: the current step's words, in ink.
  headWorking: {
    color: grasp.ink,
  },
  time: {
    flexShrink: 0,
    fontVariantNumeric: "tabular-nums",
    color: grasp.muted,
  },
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    color: grasp.muted,
    transitionProperty: "transform",
    transitionDuration: simply.leave,
    transitionTimingFunction: grasp.ease,
  },
  chevronOpen: {
    transform: "rotate(0.5turn)",
    transitionDuration: simply.ui,
  },

  // The steps: a column, a quiet line down their marks joining them.
  panel: {
    overflow: "hidden",
    height: "var(--collapsible-panel-height)",
    transitionProperty: "height",
    transitionDuration: {
      default: simply.ui,
      ":is([data-ending-style])": simply.leave,
    },
    transitionTimingFunction: grasp.ease,
    ":is([data-starting-style], [data-ending-style])": { height: 0 },
  },
  steps: {
    position: "relative",
    display: "grid",
    rowGap: 0,
    margin: 0,
    paddingBlock: grasp.space1,
    paddingInline: 0,
    listStyle: "none",
  },
  // A step: its mark, its words and its time. New steps fade in.
  step: {
    position: "relative",
    display: "grid",
    gridTemplateColumns: `${grasp.iconSm} minmax(0, 1fr)`,
    columnGap: grasp.space3,
    alignItems: "start",
    // With reduced motion a new step is simply there.
    animationName: { default: arrive, [REDUCED]: "none" },
    animationDuration: grasp.durationUi,
    animationTimingFunction: grasp.ease,
    animationFillMode: "backwards",
  },
  // The joining line, from under one mark to the next, clear of both by space-1: a line of fine
  // dots, faint ahead of the work and drawn in muted ink once the step above it is done.
  join: {
    position: "absolute",
    insetInlineStart: `calc(${grasp.iconSm} / 2 - ${grasp.hairline})`,
    top: `calc(${grasp.space2} + ${grasp.textSmLine} - (${grasp.textSmLine} - ${grasp.iconSm}) / 2 + ${grasp.space1})`,
    bottom: `calc(${grasp.space1} - ${grasp.space2} - (${grasp.textSmLine} - ${grasp.iconSm}) / 2)`,
    width: `calc(${grasp.hairline} * 2)`,
    backgroundImage: `radial-gradient(circle, currentColor calc(${grasp.hairline} * 0.75), transparent calc(${grasp.hairline} * 1.1))`,
    backgroundSize: `100% ${grasp.space1}`,
    backgroundRepeat: "repeat-y",
    color: { default: grasp.workingMarkRest, [FORCED]: "GrayText" },
    forcedColorAdjust: "none",
  },
  joinDone: { color: { default: grasp.muted, [FORCED]: "CanvasText" } },
  // A step's dot where its icon would stand: muted ink when done, faint while it waits.
  dot: {
    width: `calc(${grasp.space1} + ${grasp.space1} / 4)`,
    height: `calc(${grasp.space1} + ${grasp.space1} / 4)`,
    borderRadius: grasp.cornerCircle,
    backgroundColor: { default: grasp.muted, [FORCED]: "CanvasText" },
    forcedColorAdjust: "none",
  },
  dotWaiting: {
    backgroundColor: { default: grasp.workingMarkRest, [FORCED]: "GrayText" },
  },
  mark: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: grasp.iconSm,
    height: grasp.textSmLine,
    marginBlockStart: grasp.space2,
    color: grasp.muted,
  },
  markFailed: { color: grasp.danger },
  markSkipped: { color: grasp.muted, opacity: grasp.dim },
  body: {
    display: "grid",
    minWidth: 0,
    paddingBlock: grasp.space2,
  },
  // A step's line: what it was, and a quiet summary; a press opens its detail when it has one.
  line: {
    display: "flex",
    alignItems: "baseline",
    flexWrap: "wrap",
    columnGap: grasp.space2,
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: grasp.text,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    textAlign: "start",
  },
  lineButton: {
    position: "relative",
    width: "100%",
    cursor: "pointer",
    color: {
      default: grasp.text,
      ":hover": { default: null, [HOVER]: grasp.ink },
    },
    borderRadius: grasp.cornerMark,
  },
  title: {
    color: "inherit",
    overflowWrap: "anywhere",
  },
  // Done steps step back; the working one stands in ink.
  titleDone: { color: grasp.muted },
  titleWaiting: { color: grasp.muted },
  titleWorking: { color: grasp.ink },
  titleSkipped: { color: grasp.muted, textDecorationLine: "line-through" },
  summary: {
    color: grasp.muted,
    overflowWrap: "anywhere",
  },
  // Quiet, after the words, in the same run of text. Centred in the line, not on its baseline: a
  // 13px time on a 14px title's baseline pushed its 20px box 1px below the line, so a row with a
  // time stood 1px taller than one without.
  stepTime: {
    alignSelf: "center",
    fontVariantNumeric: "tabular-nums",
    color: grasp.muted,
    fontSize: grasp.textXs,
  },
  failed: {
    color: grasp.danger,
  },
  // A step's detail: its input and its result, in mono, on the soft ground, cut to a few lines.
  detail: {
    display: "grid",
    rowGap: grasp.space2,
    marginBlockStart: grasp.space2,
    minWidth: 0,
  },
  block: {
    display: "grid",
    rowGap: grasp.space1,
    minWidth: 0,
  },
  blockLabel: {
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  code: {
    margin: 0,
    boxSizing: "border-box",
    maxWidth: "100%",
    paddingBlock: grasp.space2,
    paddingInline: grasp.space3,
    borderRadius: `min(${grasp.corner}, ${grasp.space3})`,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.soft,
    boxShadow: grasp.edge,
    // In forced colours the edge is dropped, so a border draws the block there.
    borderWidth: { default: 0, [FORCED]: grasp.hairline },
    borderStyle: "solid",
    borderColor: "CanvasText",
    color: grasp.text,
    fontFamily: grasp.fontMono,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  // The words inside the block; cut to six lines until "Show more", inside the padding, so no
  // part of a seventh line shows.
  codeWords: {
    display: "block",
  },
  cut: {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 6,
    overflow: "hidden",
  },
  // Show more's words on the labels' edge (Input, Result), its hover fill reaching past it, as the
  // one line's: back by the small button's own padding.
  more: {
    justifySelf: "start",
    marginInlineStart: `calc(-1 * ${grasp.space3})`,
  },

  // A step that opens says so: a small chevron after its line, turning while open.
  stepChevron: {
    display: "inline-flex",
    alignSelf: "center",
    [iconVars.size]: `calc(${grasp.iconSm} - ${grasp.space1})`,
    color: grasp.muted,
    transitionProperty: "transform",
    transitionDuration: simply.leave,
    transitionTimingFunction: grasp.ease,
  },
  // A finger needs 44px: an unseen area round a line that opens. A step's line covers its row,
  // and on a touch screen both lines reach 44px.
  target: {
    position: "absolute",
    insetInline: 0,
    insetBlock: {
      default: 0,
      [media.coarse]: `calc((${grasp.controlSm} - ${grasp.tap}) / 2)`,
    },
  },
  stepTarget: {
    position: "absolute",
    insetInline: 0,
    insetBlock: {
      default: `calc(-1 * ${grasp.space2})`,
      [media.coarse]: `calc((${grasp.textSmLine} - ${grasp.tap}) / 2)`,
    },
  },
});
