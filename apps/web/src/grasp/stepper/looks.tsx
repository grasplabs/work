"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { TooltipTrigger as TriggerPrimitive } from "@ui-sdk/react/tooltip";
import type { ReactElement, ReactNode } from "react";

import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { Cross, Icon, Tick } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { Tooltip, TooltipContent } from "../tooltip";
import { useWords } from "../words/words";
import { canPress, shownState } from "./reach";
import type { StepperProps, StepperState, StepperStep } from "./stepper";
import { stepMarker } from "./stepper.stylex";
import { stepperWords } from "./words";

const FORCED = media.forced;
const REDUCED = media.reduced;
const PHONE = media.belowPhone;

type Look = "light" | "dither" | "serif";

// The working light's stretch, once along the line: from before its start to past its end (its own
// width is 40% of the line, so 250% of itself is the whole line), the other way right to left.
const travelAcross = stylex.keyframes({
  from: { transform: "translateX(calc(-100% * var(--stepper-sign)))" },
  to: { transform: "translateX(calc(250% * var(--stepper-sign)))" },
});
const travelDown = stylex.keyframes({
  from: { transform: "translateY(-100%)" },
  to: { transform: "translateY(250%)" },
});

/** How far a line between two steps stops short of each step's middle: past the current step's ring,
 * and the line's own gap. */
const LINE_OFF = `(${grasp.stepperDotCurrent} / 2 + ${grasp.stepperRingGap} + ${grasp.stepperRing} + ${grasp.stepperLineGap})`;
/** The current step's ring, across: the light look's mark is as tall as it. */
const RING = `(${grasp.stepperDotCurrent} + 2 * (${grasp.stepperRingGap} + ${grasp.stepperRing}))`;
/** Across, where the light look's dots stand in their column: the start edge, its name under it
 * from the same edge (Ruben's pick); the middle of the dot, from the column's start and top. */
const DOT_X = `(${grasp.stepperDotCurrent} / 2)`;
const DOT_Y = `(${RING} / 2)`;

// The size of a step's mark in each look: the line and the light are placed from it.
// The corner of each look's mark, and its shape, for the press's ring round it: a circle round the
// light's round mark, the tile's own squircle round a tile.
const markCorner: Record<Look, string> = {
  light: grasp.cornerCircle,
  dither: `calc(${grasp.corner} / 2)`,
  serif: grasp.cornerMark,
};
const markShape: Record<Look, string> = {
  light: "round",
  dither: grasp.cornerShape,
  serif: grasp.cornerShape,
};

// Down, the room between one step and the next: a gap between equal rows, not padding under
// each step, so the last step has nothing empty under it. What is drawn behind the steps is
// placed by the row and this gap.
const GAP_DOWN = grasp.space5;
/** A row's height down, from the whole: the rows share what the gaps leave. */
const rowDown = (count: number) =>
  `((100% - ${count - 1} * ${GAP_DOWN}) / ${count})`;

const markSize: Record<Look, string> = {
  light: grasp.stepperMark,
  dither: grasp.stepperTile,
  serif: `calc(${grasp.stepperNumeral} + ${grasp.space2})`,
};

const styles = stylex.create({
  root: {
    // -1 right to left: what moves across moves the other way.
    "--stepper-sign": { default: "1", ":dir(rtl)": "-1" },
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    minWidth: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  // What the caller places: the stepper's own box, round the drawing (root).
  frame: { minWidth: 0 },
  // The marks alone, across: a calm pitch for each step instead of the whole width, never wider
  // than what holds it (on a phone the steps share it, as with their names).
  // From the first mark's start edge to the last one's end edge; a phone keeps the whole width.
  pitch: (count: number, mark: string) => ({
    width: {
      default: `calc(${count - 1} * ${grasp.stepperPitch} + ${mark})`,
      [PHONE]: "100%",
    },
    maxWidth: "100%",
  }),
  // The drawing reaches half a pitch past the frame on each side, less half a mark, so each mark
  // stands in the middle of its pitch and the first is flush with the content. On a phone the row
  // is today's: the whole width, each light dot on its column's start edge.
  pitchRoot: (mark: string) => ({
    marginInline: {
      default: `calc((${mark} - ${grasp.stepperPitch}) / 2)`,
      [PHONE]: 0,
    },
  }),
  // The light look: 1 where its dots stand in their columns' middle, 0 on their start edge.
  centre: {
    "--stepper-centre": { default: "1", [PHONE]: "0" },
  },
  stepMarksLight: {
    paddingInlineStart: { default: grasp.space1, [PHONE]: 0 },
    paddingInlineEnd: { default: grasp.space1, [PHONE]: grasp.space3 },
  },
  hitMarksLight: {
    justifyItems: { default: "center", [PHONE]: "start" },
  },
  list: {
    position: "relative",
    zIndex: 1,
    display: "grid",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  columns: (count: number) => ({
    gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
  }),
  // Down: every row as tall as the tallest, so a step's place is its index.
  rows: {
    gridTemplateColumns: "minmax(0, 1fr)",
    gridAutoRows: "1fr",
    rowGap: GAP_DOWN,
  },
  step: {
    display: "grid",
    minWidth: 0,
  },
  stepAcross: {
    paddingInline: grasp.space1,
  },
  // The light look, across: each step starts on its column's start edge, the row flush with the
  // content's; a little room at the end keeps a wrapped name off the next.
  stepAcrossStart: {
    paddingInlineStart: 0,
    paddingInlineEnd: grasp.space3,
  },
  // ---- What a step holds, and what a person presses when it can be gone back to ----
  hit: {
    position: "relative",
    display: "grid",
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: `calc(${grasp.corner} / 2)`,
    cornerShape: grasp.cornerShape,
    backgroundColor: "transparent",
    color: "inherit",
    font: "inherit",
    textAlign: "inherit",
  },
  hitAcross: {
    justifyItems: "center",
    alignContent: "start",
    // Across a phone the names fold away: no gap is kept for them under the marks.
    rowGap: { default: grasp.space2, [PHONE]: 0 },
    textAlign: "center",
  },
  hitAcrossStart: {
    justifyItems: "start",
    textAlign: "start",
  },
  foldStart: { textAlign: "start" },
  // The light look's mark across: as wide as the current dot and as tall as its ring, at the start
  // of the column; the ring stands past it at the start, as in the pick.
  lightMarkAcross: {
    width: grasp.stepperDotCurrent,
    height: RING,
  },
  // The marks alone: as wide as the ring too, so the dot stands in the middle of its pitch and the
  // line as far from the step before as from the step after. On a phone, as with names.
  lightMarkPitched: {
    width: { default: RING, [PHONE]: grasp.stepperDotCurrent },
  },
  // A finger needs 44px: an unseen area round the press makes up what it is shorter, without
  // making the row taller than what it shows.
  target: {
    position: "absolute",
    insetInline: 0,
    insetBlock: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
  },
  // The marks alone: a column may be narrower than a finger (nine steps on a phone), so the
  // target is 44px wide round the mark's middle as well.
  targetWide: {
    insetInline: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
  },
  // Down, the press reaches a little past the round mark on every side, given back by the margin,
  // so its target holds the mark and the words and nothing moves; its ring is on the mark.
  hitDown: (mark: string) => ({
    gridTemplateColumns: `${mark} minmax(0, 1fr)`,
    columnGap: grasp.space3,
    alignItems: "start",
    textAlign: "start",
    marginInline: `calc(-1 * ${grasp.space2})`,
    marginBlock: `calc(-1 * ${grasp.space1})`,
    paddingInline: grasp.space2,
    paddingBlock: grasp.space1,
  }),
  pressable: {
    cursor: "pointer",
    appearance: "none",
    backgroundColor: {
      default: "transparent",
      ":hover": grasp.itemFillHighlight,
    },
    transitionProperty: "background-color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  // The line runs through the steps from mark to mark, across and down: a box round a whole step
  // would be crossed by it (A-nav-13 across; A3-nav-04 down, through a done step's ring and fill).
  // The press shows on its mark instead, the node the line joins: the ring round the mark, a soft
  // fill behind it under the pointer, and the name in ink.
  pressOnMark: {
    outline: "none",
    backgroundColor: "transparent",
  },
  markPress: (corner: string, shape: string) => ({
    borderRadius: corner,
    cornerShape: shape,
    outline: {
      default: "none",
      [stylex.when.ancestor(":focus-visible", stepMarker)]: {
        default: `${grasp.ringWidth} solid ${grasp.ring}`,
        [FORCED]: `calc(2 * ${grasp.ringWidth}) solid Highlight`,
      },
    },
    outlineOffset: grasp.ringOffset,
    boxShadow: {
      default: "none",
      [stylex.when.ancestor(":hover", stepMarker)]:
        `0 0 0 ${grasp.space1} ${grasp.itemFillHighlight}`,
    },
    transitionProperty: "box-shadow",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  }),
  // The marks alone: a step that is not a button still takes focus for its tooltip; its ring is on
  // its mark, with no hover fill (nothing to press).
  markFocus: (corner: string, shape: string) => ({
    borderRadius: corner,
    cornerShape: shape,
    outline: {
      default: "none",
      [stylex.when.ancestor(":focus-visible", stepMarker)]: {
        default: `${grasp.ringWidth} solid ${grasp.ring}`,
        [FORCED]: `calc(2 * ${grasp.ringWidth}) solid Highlight`,
      },
    },
    outlineOffset: grasp.ringOffset,
  }),
  nameHover: {
    color: {
      default: null,
      [stylex.when.ancestor(":hover", stepMarker)]: grasp.ink,
    },
  },
  // ---- The words ----
  words: {
    display: "grid",
    rowGap: grasp.space1,
    minWidth: 0,
    maxWidth: "100%",
  },
  wordsDown: (mark: string) => ({
    // The name stands level with the middle of its mark.
    paddingBlockStart: `calc((${mark} - ${grasp.textSmLine}) / 2)`,
  }),
  // A name wraps on a narrow row; it is never cut short.
  name: {
    overflowWrap: "break-word",
    textWrap: "balance",
    transitionProperty: "color",
    transitionDuration: simply.mark,
    transitionTimingFunction: grasp.ease,
  },
  // Across a phone, the names give way to the one line under the row; still read.
  nameFolds: {
    position: { default: null, [PHONE]: "absolute" },
    width: { default: null, [PHONE]: 1 },
    height: { default: null, [PHONE]: 1 },
    margin: { default: null, [PHONE]: -1 },
    clipPath: { default: null, [PHONE]: "inset(50%)" },
  },
  coming: { color: grasp.muted },
  current: { color: grasp.ink, fontWeight: grasp.weightMedium },
  done: { color: grasp.text },
  failed: { color: grasp.danger, fontWeight: grasp.weightMedium },
  description: {
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    textWrap: "pretty",
  },
  fold: {
    display: { default: "none", [PHONE]: "block" },
    marginBlockStart: grasp.space2,
    overflowWrap: "break-word",
    textWrap: "balance",
    textAlign: "center",
    color: grasp.ink,
  },
  foldCount: { color: grasp.muted },
  // ---- The mark: one box per look, the same size in every state ----
  mark: (size: string) => ({
    position: "relative",
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: size,
    height: size,
  }),
  // Something stacked in the mark: all its layers share one cell.
  layer: {
    gridArea: "1 / 1",
    display: "grid",
    placeItems: "center",
  },
  // A tick or a cross drawn in from the start, and gone at once when it is not wanted.
  drawn: {
    clipPath: {
      default: "inset(0 100% 0 0)",
      ":dir(rtl)": "inset(0 0 0 100%)",
    },
    opacity: 0,
    transitionProperty: "clip-path, opacity",
    transitionDuration: `${simply.ui}, 0s`,
    transitionTimingFunction: grasp.ease,
  },
  drawnIn: {
    clipPath: "inset(0 0 0 0)",
    opacity: 1,
  },
  // light: a small dot in the mark's box, the same box in every state. In forced colours the marks
  // keep their own system colours and their shapes (filled, open, ringed, square) tell the states
  // apart without colour.
  dot: {
    boxSizing: "border-box",
    width: grasp.stepperDot,
    height: grasp.stepperDot,
    borderRadius: grasp.cornerCircle,
    // Every dot has the same edge; its colour, with the fill, says the state, so a change of state
    // is a change of colour and size and nothing blinks out on the way.
    borderWidth: grasp.stepperRing,
    borderStyle: "solid",
    forcedColorAdjust: "none",
    transitionProperty:
      "width, height, background-color, border-color, border-radius",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  dotComing: {
    backgroundColor: "transparent",
    borderColor: { default: grasp.muted, [FORCED]: "CanvasText" },
  },
  dotDone: {
    backgroundColor: { default: grasp.mintDeep, [FORCED]: "CanvasText" },
    borderColor: { default: grasp.mintDeep, [FORCED]: "CanvasText" },
  },
  dotCurrent: {
    width: grasp.stepperDotCurrent,
    height: grasp.stepperDotCurrent,
    backgroundColor: { default: grasp.mintDeep, [FORCED]: "Highlight" },
    borderColor: { default: grasp.mintDeep, [FORCED]: "Highlight" },
  },
  dotFailed: {
    width: grasp.stepperDotCurrent,
    height: grasp.stepperDotCurrent,
    borderRadius: 2,
    backgroundColor: { default: grasp.danger, [FORCED]: "CanvasText" },
    borderColor: { default: grasp.danger, [FORCED]: "CanvasText" },
  },
  // The current step's one quiet ring, round its dot; it gives way to the working light.
  ring: {
    boxSizing: "border-box",
    width: `calc(${grasp.stepperDotCurrent} + 2 * (${grasp.stepperRingGap} + ${grasp.stepperRing}))`,
    height: `calc(${grasp.stepperDotCurrent} + 2 * (${grasp.stepperRingGap} + ${grasp.stepperRing}))`,
    borderRadius: grasp.cornerCircle,
    borderWidth: grasp.stepperRing,
    borderStyle: "solid",
    borderColor: {
      default: `color-mix(in oklch, ${grasp.mintDeep} 55%, transparent)`,
      [FORCED]: "Highlight",
    },
    forcedColorAdjust: "none",
    opacity: 0,
    transitionProperty: "opacity",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  ringOn: { opacity: 1 },
  // dither: a squircle tile on the low lift.
  tile: {
    [iconVars.size]: grasp.iconSm,
    boxSizing: "border-box",
    width: "100%",
    height: "100%",
    borderRadius: `calc(${grasp.corner} / 2)`,
    cornerShape: grasp.cornerShape,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    boxShadow: grasp.liftLow,
    fontSize: grasp.textXs,
    lineHeight: 1,
    fontWeight: grasp.weightMedium,
    fontVariantNumeric: "tabular-nums",
    transitionProperty: "background-color, color",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  tileComing: { backgroundColor: grasp.raised, color: grasp.muted },
  tileCurrent: {
    backgroundImage: grasp.approveLight,
    color: grasp.approveText,
    borderWidth: { default: 0, [FORCED]: 2 },
    borderColor: "Highlight",
  },
  tileDone: { backgroundColor: grasp.soft, color: grasp.pine },
  tileFailed: { backgroundColor: grasp.dangerSoft, color: grasp.danger },
  // serif: the numeral, and the tick or cross that takes its place.
  numeral: {
    fontFamily: grasp.fontSerif,
    fontSize: grasp.stepperNumeral,
    lineHeight: 1,
    fontVariantNumeric: "lining-nums tabular-nums",
    transitionProperty: "opacity, color",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  numeralComing: { color: grasp.muted, opacity: 0.55 },
  numeralCurrent: { color: grasp.ink, opacity: 1 },
  numeralGone: { opacity: 0 },
  serifIcon: {
    [iconVars.size]: grasp.iconMd,
  },
  serifDone: { color: grasp.mintDeep },
  serifFailed: { color: grasp.danger },
  // ---- What lies behind the steps: the line, its fill, the dither bands, what moves ----
  behind: {
    position: "absolute",
    pointerEvents: "none",
  },
  // light: one line between each two steps, stopping short of both: a hairline, or solid in the
  // value colour once the step before it is done.
  segAcross: (index: number, count: number, dot: string) => ({
    insetInlineStart: `calc(${(index / count) * 100}% + ${dot} + ${LINE_OFF})`,
    width: `calc(100% / ${count} - 2 * ${LINE_OFF})`,
    top: `calc(${DOT_Y} - ${grasp.stepperLine} / 2)`,
    height: grasp.stepperLine,
  }),
  segDown: (index: number, count: number, mark: string) => ({
    insetInlineStart: `calc(${mark} / 2 - ${grasp.stepperLine} / 2)`,
    width: grasp.stepperLine,
    top: `calc(${index} * (${rowDown(count)} + ${GAP_DOWN}) + ${mark} / 2 + ${LINE_OFF})`,
    height: `calc(${rowDown(count)} + ${GAP_DOWN} - 2 * ${LINE_OFF})`,
  }),
  seg: {
    display: "grid",
    placeItems: "center",
  },
  // The hairline drawn in the middle of the segment's room; once done it fills that room.
  segLine: {
    borderRadius: 1,
    backgroundColor: { default: grasp.line, [FORCED]: "GrayText" },
    forcedColorAdjust: "none",
    transitionProperty: "background-color, width, height",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  // One weight for the whole line: the colour alone says what is done.
  segLineAcross: { width: "100%", height: grasp.stepperLine },
  segLineDown: { width: grasp.stepperLine, height: "100%" },
  segDone: {
    backgroundColor: { default: grasp.mintDeep, [FORCED]: "CanvasText" },
  },
  // The mover: one step wide (or tall), so moving it by 100% of itself moves it one step, and on
  // the last step it still ends where the stepper does (it never makes the page scroll).
  moverAcross: (at: number, count: number) => ({
    insetInlineStart: 0,
    width: `calc(100% / ${count})`,
    top: 0,
    bottom: 0,
    transform: `translateX(calc(${at * 100}% * var(--stepper-sign)))`,
  }),
  moverDown: (at: number, count: number) => ({
    top: 0,
    height: `calc${rowDown(count)}`,
    insetInlineStart: 0,
    insetInlineEnd: 0,
    // One step on is its own height and the gap.
    transform: `translateY(calc(${at} * (100% + ${GAP_DOWN})))`,
  }),
  mover: {
    transitionProperty: "transform, opacity",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  out: { opacity: 0 },
  // The working light's room: the line from the current step to the next, inside the mover, so an
  // advance carries it to the next stretch. Hidden in forced colours: the marks carry the state.
  travelRoomAcross: (dot: string) => ({
    insetInlineStart: `calc(${dot} + ${LINE_OFF})`,
    width: `calc(100% - 2 * ${LINE_OFF})`,
    top: `calc(${DOT_Y} - ${grasp.stepperLine} / 2)`,
    height: grasp.stepperLine,
  }),
  travelRoomDown: (mark: string) => ({
    insetInlineStart: `calc(${mark} / 2 - ${grasp.stepperLine} / 2)`,
    width: grasp.stepperLine,
    top: `calc(${mark} / 2 + ${LINE_OFF})`,
    height: `calc(100% + ${GAP_DOWN} - 2 * ${LINE_OFF})`,
  }),
  travelRoom: {
    position: "absolute",
    overflow: "hidden",
    borderRadius: 1,
    display: { default: null, [FORCED]: "none" },
  },
  // The stretch itself: 40% of the line. Still under reduced motion, a short lit stretch at rest
  // at the start of the line.
  travel: {
    position: "absolute",
    animationDuration: grasp.stepperTravel,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  travelAcross: {
    insetBlock: 0,
    insetInlineStart: 0,
    width: "40%",
    backgroundImage: grasp.stepperTravelAcross,
    animationName: { default: travelAcross, [REDUCED]: "none" },
  },
  travelDown: {
    insetInline: 0,
    top: 0,
    height: "40%",
    backgroundImage: grasp.stepperTravelDown,
    animationName: { default: travelDown, [REDUCED]: "none" },
  },
  // While the light is out, nothing travels that is not seen.
  travelStill: { animationPlayState: "paused" },
  underlineAcross: (mark: string) => ({
    insetInlineStart: `calc(50% - ${mark} * 0.3)`,
    top: `calc(${mark} + ${grasp.space1} / 2)`,
  }),
  underlineDown: (mark: string) => ({
    insetInlineStart: `calc(${mark} * 0.2)`,
    top: `calc(${mark} + ${grasp.space1} / 2)`,
  }),
  underline: (mark: string) => ({
    position: "absolute",
    width: `calc(${mark} * 0.6)`,
    height: 2,
    borderRadius: 1,
    backgroundColor: { default: grasp.mintDeep, [FORCED]: "Highlight" },
  }),
  bandAcross: (index: number, count: number, mark: string) => ({
    insetInlineStart: `calc(${((index + 0.5) / count) * 100}% + ${mark} / 2 + ${grasp.stepperLineGap})`,
    width: `calc(100% / ${count} - ${mark} - 2 * ${grasp.stepperLineGap})`,
    top: `calc(${mark} / 2 - ${grasp.stepperBand} / 2)`,
    height: grasp.stepperBand,
  }),
  bandDown: (index: number, count: number, mark: string) => ({
    insetInlineStart: `calc(${mark} / 2 - ${grasp.stepperBand} / 2)`,
    width: grasp.stepperBand,
    top: `calc(${index} * (${rowDown(count)} + ${GAP_DOWN}) + ${mark} + ${grasp.stepperLineGap})`,
    height: `calc(${rowDown(count)} + ${GAP_DOWN} - ${mark} - 2 * ${grasp.stepperLineGap})`,
  }),
  band: {
    backgroundImage: `radial-gradient(circle, ${grasp.line} 1px, transparent 1.5px)`,
    backgroundSize: `${grasp.stepperDotsSparse} ${grasp.stepperDotsSparse}`,
    backgroundPosition: "center",
    backgroundColor: { default: null, [FORCED]: "CanvasText" },
  },
  made: {
    position: "absolute",
    inset: 0,
    borderRadius: 1,
    // Dense dots in the deep mint over a faint wash of the same: made, but still a texture.
    backgroundImage: `radial-gradient(circle, ${grasp.mintDeep} 1px, transparent 1.25px), linear-gradient(${grasp.successSoft}, ${grasp.successSoft})`,
    backgroundSize: `${grasp.stepperDotsDense} ${grasp.stepperDotsDense}, auto`,
    backgroundColor: { default: null, [FORCED]: "Highlight" },
    transitionProperty: "opacity",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  madeBy: (part: number) => ({
    opacity: part,
  }),
});

const nameStyles = {
  coming: styles.coming,
  current: styles.current,
  done: styles.done,
  failed: styles.failed,
} as const;
const dotStyles = {
  coming: styles.dotComing,
  current: styles.dotCurrent,
  done: styles.dotDone,
  failed: styles.dotFailed,
} as const;
const tileStyles = {
  coming: styles.tileComing,
  current: styles.tileCurrent,
  done: styles.tileDone,
  failed: styles.tileFailed,
} as const;

const placeOf = (index: number, current: number): StepperState => {
  if (index < current) {
    return "done";
  }
  return index === current ? "current" : "coming";
};

const stateOf = (
  step: StepperStep,
  index: number,
  current: number
): StepperState => step.state ?? placeOf(index, current);

/** The ring a step's mark answers with: a press's (hover and focus), focus alone, or none. */
type Ring = "press" | "focus" | undefined;

const ringOf = (look: Look, ring: Ring) => {
  if (ring === "press") {
    return styles.markPress(markCorner[look], markShape[look]);
  }
  return (
    ring === "focus" && styles.markFocus(markCorner[look], markShape[look])
  );
};

const Drawn = ({ on, children }: { on: boolean; children: ReactNode }) => (
  <span {...stylex.props(styles.layer, styles.drawn, on && styles.drawnIn)}>
    {children}
  </span>
);

/** The light look's mark: the dot, and round the current one its ring while it is not at work. */
const LightMark = ({
  state,
  ring,
  working,
  across,
  pitched,
}: {
  state: StepperState;
  ring: Ring;
  working: boolean;
  across: boolean;
  pitched: boolean;
}) => (
  <span
    aria-hidden="true"
    data-state={state}
    {...stylex.props(
      styles.mark(markSize.light),
      across && styles.lightMarkAcross,
      pitched && styles.lightMarkPitched,
      ringOf("light", ring)
    )}
  >
    <span
      data-part="ring"
      {...stylex.props(
        styles.layer,
        styles.ring,
        state === "current" && !working && styles.ringOn
      )}
    />
    <span
      data-part="dot"
      {...stylex.props(styles.layer, styles.dot, dotStyles[state])}
    />
  </span>
);

const TileMark = ({
  state,
  number,
  ring,
}: {
  state: StepperState;
  number: number;
  ring: Ring;
}) => (
  <span
    aria-hidden="true"
    data-state={state}
    {...stylex.props(styles.mark(markSize.dither), ringOf("dither", ring))}
  >
    <span {...stylex.props(styles.layer, styles.tile, tileStyles[state])}>
      <span
        {...stylex.props(
          styles.layer,
          (state === "done" || state === "failed") && styles.numeralGone
        )}
      >
        {number}
      </span>
      <Drawn on={state === "done"}>
        <Icon icon={Tick} />
      </Drawn>
      <Drawn on={state === "failed"}>
        <Icon icon={Cross} />
      </Drawn>
    </span>
  </span>
);

const numeralLook = (state: StepperState) => {
  if (state === "coming") {
    return styles.numeralComing;
  }
  return state === "current" ? styles.numeralCurrent : styles.numeralGone;
};

const SerifMark = ({
  state,
  number,
  ring,
}: {
  state: StepperState;
  number: number;
  ring: Ring;
}) => (
  <span
    aria-hidden="true"
    data-state={state}
    {...stylex.props(styles.mark(markSize.serif), ringOf("serif", ring))}
  >
    <span {...stylex.props(styles.layer, styles.numeral, numeralLook(state))}>
      {number}
    </span>
    <span {...stylex.props(styles.layer, styles.serifIcon, styles.serifDone)}>
      <Drawn on={state === "done"}>
        <Icon icon={Tick} />
      </Drawn>
    </span>
    <span {...stylex.props(styles.layer, styles.serifIcon, styles.serifFailed)}>
      <Drawn on={state === "failed"}>
        <Icon icon={Cross} />
      </Drawn>
    </span>
  </span>
);

const Mark = ({
  look,
  state,
  number,
  ring,
  working,
  across,
  pitched,
}: {
  look: Look;
  state: StepperState;
  number: number;
  ring: Ring;
  working: boolean;
  across: boolean;
  pitched: boolean;
}) => {
  if (look === "dither") {
    return <TileMark state={state} number={number} ring={ring} />;
  }
  if (look === "serif") {
    return <SerifMark state={state} number={number} ring={ring} />;
  }
  return (
    <LightMark
      state={state}
      ring={ring}
      working={working}
      across={across}
      pitched={pitched}
    />
  );
};

/** How made a dither band is: done behind a done step, half made leaving the current one. */
const madeOf = (index: number, states: readonly StepperState[]) => {
  if (states[index] === "done" && states[index + 1] !== "coming") {
    return 1;
  }
  return states[index] === "current" ? 0.35 : 0;
};

const Behind = ({
  look,
  across,
  count,
  current,
  states,
  working,
  centred,
}: {
  look: Look;
  across: boolean;
  count: number;
  current: number;
  states: readonly StepperState[];
  working: boolean;
  centred: boolean;
}) => {
  const mark = markSize[look];
  const at = Math.min(Math.max(current, 0), Math.max(count - 1, 0));
  const lit = current < count && states[current] !== "failed";
  const mover = across
    ? styles.moverAcross(at, count)
    : styles.moverDown(at, count);
  if (look === "dither") {
    return (
      <>
        {states.slice(0, -1).map((state, index) => (
          <span
            // Each band sits between two fixed steps: its index is its place.
            key={`band-${index}-${state}`}
            aria-hidden="true"
            {...stylex.props(
              styles.behind,
              styles.band,
              across
                ? styles.bandAcross(index, count, mark)
                : styles.bandDown(index, count, mark)
            )}
          >
            <span
              {...stylex.props(
                styles.made,
                styles.madeBy(madeOf(index, states))
              )}
            />
          </span>
        ))}
      </>
    );
  }
  if (look === "serif") {
    return (
      <span
        aria-hidden="true"
        {...stylex.props(
          styles.behind,
          styles.mover,
          mover,
          !lit && styles.out
        )}
      >
        <span
          {...stylex.props(
            styles.underline(mark),
            across ? styles.underlineAcross(mark) : styles.underlineDown(mark)
          )}
        />
      </span>
    );
  }
  // light: the line in its stretches, and the working light on the one after the current step,
  // there only while that step is in progress and has a next step to travel to.
  const travelling = working && lit && at < count - 1;
  // Where a dot's middle stands: on its column's start edge, or (the marks alone) in its middle;
  // from the whole row for a stretch of line, from the mover's one column for the light.
  const lineDot = centred
    ? `(var(--stepper-centre) * 100% / ${count} / 2 + (1 - var(--stepper-centre)) * ${DOT_X})`
    : DOT_X;
  const lightDot = centred
    ? `(var(--stepper-centre) * 50% + (1 - var(--stepper-centre)) * ${DOT_X})`
    : DOT_X;
  return (
    <>
      {states.slice(0, -1).map((state, index) => {
        const done = state === "done";
        return (
          <span
            // Each stretch sits between two fixed steps: its index is its place.
            key={`line-${index}`}
            aria-hidden="true"
            data-part="line"
            data-done={done ? "" : undefined}
            {...stylex.props(
              styles.behind,
              styles.seg,
              across
                ? styles.segAcross(index, count, lineDot)
                : styles.segDown(index, count, mark)
            )}
          >
            <span
              {...stylex.props(
                styles.segLine,
                across ? styles.segLineAcross : styles.segLineDown,
                done && styles.segDone
              )}
            />
          </span>
        );
      })}
      <span
        aria-hidden="true"
        {...stylex.props(
          styles.behind,
          styles.mover,
          mover,
          !travelling && styles.out
        )}
      >
        <span
          {...stylex.props(
            styles.travelRoom,
            across
              ? styles.travelRoomAcross(lightDot)
              : styles.travelRoomDown(mark)
          )}
        >
          <span
            data-part="light"
            {...stylex.props(
              styles.travel,
              across ? styles.travelAcross : styles.travelDown,
              !travelling && styles.travelStill
            )}
          />
        </span>
      </span>
    </>
  );
};

/** A click handler, as the tooltip's trigger may lend one. */
type Press = (event: unknown) => void;
const isPress = (value: unknown): value is Press => typeof value === "function";

/** What a step's hit is drawn as: a button or a span, with the props its tooltip's trigger lends. */
type DrawHit = (
  lent: Record<string, unknown>,
  lentPress?: Press
) => ReactElement;

/**
 * The marks alone: a step's hit is its tooltip's trigger, the name its words. The tooltip repeats
 * the name the step already says, so a screen reader is not told it twice (as Breadcrumb's name). A
 * step that is not a button still takes focus, so the keyboard reaches its name.
 */
const Tipped = ({
  name,
  tipped,
  focusable,
  draw,
}: {
  name: string;
  tipped: boolean;
  focusable: boolean;
  draw: DrawHit;
}) => {
  if (!tipped) {
    return draw({});
  }
  return (
    <Tooltip>
      <TriggerPrimitive
        tabIndex={focusable ? 0 : undefined}
        render={({
          type: _type,
          "aria-describedby": _description,
          onClick,
          ...lent
        }: Record<string, unknown>) =>
          draw(lent, isPress(onClick) ? onClick : undefined)
        }
      />
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
};

interface StepItemProps {
  step: StepperStep;
  index: number;
  state: StepperState;
  /** How its state is said, after its name. */
  stateWords: string;
  drawn: Look;
  across: boolean;
  labelsHidden: boolean;
  working: boolean;
  /** Pressed, it goes to this step: given when the step can be pressed. */
  onSelect: ((index: number) => void) | undefined;
  /** The light look across with names: on its column's start edge. */
  start: boolean;
  /** The light look's marks alone: in its column's middle, but on a phone. */
  marksLight: boolean;
}

/** One step: its mark and its words; a button when it can be pressed; with the marks alone, its tooltip. */
const StepItem = ({
  step,
  index,
  state,
  stateWords,
  drawn,
  across,
  labelsHidden,
  working,
  onSelect,
  start,
  marksLight,
}: StepItemProps) => {
  const mark = markSize[drawn];
  const pressable = onSelect !== undefined;
  const words = (
    <span
      {...stylex.props(
        styles.words,
        !across && styles.wordsDown(mark),
        labelsHidden && visuallyHidden
      )}
    >
      <span
        {...stylex.props(
          styles.name,
          nameStyles[state],
          across && !labelsHidden && styles.nameFolds,
          pressable && styles.nameHover
        )}
      >
        {step.label}
        <span {...stylex.props(visuallyHidden)}>, {stateWords}</span>
      </span>
      {!across && step.description !== undefined && (
        <span {...stylex.props(styles.description)}>{step.description}</span>
      )}
    </span>
  );
  let ring: Ring;
  if (pressable) {
    ring = "press";
  } else if (labelsHidden) {
    ring = "focus";
  }
  const inside = (
    <>
      {pressable && (
        <span
          aria-hidden="true"
          {...stylex.props(styles.target, labelsHidden && styles.targetWide)}
        />
      )}
      <Mark
        look={drawn}
        state={state}
        number={index + 1}
        ring={ring}
        working={working}
        across={across}
        pitched={marksLight}
      />
      {words}
    </>
  );
  const layout = across ? styles.hitAcross : styles.hitDown(mark);
  const draw: DrawHit = (lent, lentPress) => {
    if (onSelect !== undefined) {
      return (
        <button
          {...lent}
          type="button"
          onClick={(event) => {
            lentPress?.(event);
            onSelect(index);
          }}
          {...stylex.props(
            stepMarker,
            styles.hit,
            layout,
            start && styles.hitAcrossStart,
            marksLight && styles.hitMarksLight,
            styles.pressable,
            focus.ring,
            styles.pressOnMark
          )}
        >
          {inside}
        </button>
      );
    }
    if (labelsHidden) {
      return (
        <span
          {...lent}
          {...stylex.props(
            stepMarker,
            styles.hit,
            layout,
            marksLight && styles.hitMarksLight,
            styles.pressOnMark
          )}
        >
          {inside}
        </span>
      );
    }
    return (
      <span
        {...stylex.props(styles.hit, layout, start && styles.hitAcrossStart)}
      >
        {inside}
      </span>
    );
  };
  return (
    <li
      aria-current={state === "current" ? "step" : undefined}
      {...stylex.props(
        styles.step,
        across && styles.stepAcross,
        start && styles.stepAcrossStart,
        marksLight && styles.stepMarksLight
      )}
    >
      <Tipped
        name={step.label}
        tipped={labelsHidden}
        focusable={!pressable}
        draw={draw}
      />
    </li>
  );
};

/** Across a phone: the names give way to one line, "Step 2 of 4 · Members", or the finished words. */
const Fold = ({
  start,
  here,
  step,
  state,
  finishedLabel,
  failedWords,
}: {
  start: boolean;
  here: string | undefined;
  step: string;
  state: StepperState | undefined;
  finishedLabel: string;
  failedWords: string;
}) => (
  <div
    aria-hidden="true"
    {...stylex.props(styles.fold, start && styles.foldStart)}
  >
    {here === undefined ? (
      finishedLabel
    ) : (
      <>
        <span {...stylex.props(styles.foldCount)}>{step} · </span>
        {here}
        {/* A failed step says so in words too, not by its red mark alone. */}
        {state === "failed" && (
          <span {...stylex.props(styles.failed)}>{` · ${failedWords}`}</span>
        )}
      </>
    )}
  </div>
);

/**
 * Where the marks stand. Across, the light look's steps start on their column's edge, under their
 * names (`start`); with the marks alone every look's mark stands in its column's middle, a pitch
 * apart, but the light look on a phone (`marksLight`).
 */
const geometryOf = (
  drawn: Look,
  across: boolean,
  labelsHidden: boolean,
  count: number
) => {
  const marks = across && labelsHidden;
  const marksLight = marks && drawn === "light";
  // The mark's width across: the light look's is its current step's ring.
  const markAcross = drawn === "light" ? `calc${RING}` : markSize[drawn];
  return {
    start: across && drawn === "light" && !labelsHidden,
    marksLight,
    frame: marks && styles.pitch(count, markAcross),
    root: [marks && styles.pitchRoot(markAcross), marksLight && styles.centre],
  };
};

export const LookStepper = ({
  steps,
  current = 0,
  orientation = "horizontal",
  label,
  stateLabels,
  style,
  look = "light",
  onSelect,
  reached,
  labelsHidden = false,
  countLabel: countGiven,
  finishedLabel: finishedGiven,
  working = false,
}: StepperProps) => {
  // Its words: the product's, by its catalogue, else English; the caller's props still win.
  const catalogued = useWords("stepper", stepperWords);
  const countLabel = countGiven ?? catalogued.count;
  const finishedLabel = finishedGiven ?? catalogued.finished;
  const drawn: Look = look === "classic" ? "light" : look;
  const said = { ...catalogued.states, ...stateLabels };
  const across = orientation === "horizontal";
  const count = steps.length;
  const states = steps.map((step, index) => stateOf(step, index, current));
  const here = steps[current];
  const where =
    here === undefined
      ? finishedLabel
      : `${countLabel(current + 1, count)}: ${here.label}`;
  const { start, marksLight, frame, root } = geometryOf(
    drawn,
    across,
    labelsHidden,
    count
  );
  return (
    <div
      data-slot="stepper"
      data-look={drawn}
      data-working={working && drawn === "light" ? "" : undefined}
      data-labels-hidden={labelsHidden ? "" : undefined}
      {...stylex.props(styles.frame, frame, style)}
    >
      <div {...stylex.props(styles.root, root)}>
        <ol
          aria-label={label}
          {...stylex.props(
            styles.list,
            across ? styles.columns(count) : styles.rows
          )}
        >
          {steps.map((step, index) => {
            const state = states[index] ?? "coming";
            // Reached and come back from: drawn and said as done; the line behind still follows `current`.
            const shown = shownState(state, index, current, reached);
            return (
              <StepItem
                key={`${index}-${step.label}`}
                step={step}
                index={index}
                state={shown}
                stateWords={said[shown]}
                drawn={drawn}
                across={across}
                labelsHidden={labelsHidden}
                working={working}
                onSelect={
                  canPress(state, index, current, reached)
                    ? onSelect
                    : undefined
                }
                start={start}
                marksLight={marksLight}
              />
            );
          })}
        </ol>
        <Behind
          look={drawn}
          across={across}
          count={count}
          current={current}
          states={states}
          working={working}
          centred={marksLight}
        />
        {across && (
          <Fold
            start={drawn === "light"}
            here={here?.label}
            step={countLabel(current + 1, count)}
            state={states[current]}
            finishedLabel={finishedLabel}
            failedWords={said.failed}
          />
        )}
        <output {...stylex.props(visuallyHidden)}>{where}</output>
      </div>
    </div>
  );
};
