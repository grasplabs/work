// Stepper: progress through named steps, across or down, as the light on the line: small dots on
// one 2px line. Done is a filled dot, and the line after it in the value colour; to come is a small
// open ring on the line in a quiet colour; the current step is a filled dot with one quiet ring;
// failed is a small square in the destructive tone. While the current step is in progress
// (`loading`) the ring gives way to a short stretch of the working light travelling the line toward
// the next step: ambient, slow, and still under reduced motion.
//
//   <Stepper
//     aria-label="Setting up the workspace"
//     value={1}
//     steps={[{ label: "Details" }, { label: "Members" }, { label: "Billing" }]}
//   />
//
// An ordered list, the step you are on marked `aria-current="step"`, each step's status said in
// words. With `onValueChange` a done step is a way back to it, and with `reached` every step up to
// the furthest one reached is a way there. With `showLabels={false}` the marks stand alone, each step's
// name its tooltip. Across a phone the names give way to one line, "Step 2 of 4 · Members".
//
// StepperNav is the guided flow's Back, how far through, and Next, as a quiet bar at the top of the
// flow (`variant="bar"`) or as its foot with the step's one action (`variant="footer"`):
//
//   <StepperNav step={2} total={7} onBack={back} />                    Next submits its form
//   <StepperNav variant="bar" step={6} total={7} onBack={back} finishLabel="Create agent" />
//
// Its keys: Enter is Next where focus is not in a field of several lines or on another button;
// Mod+Enter is Next anywhere in the flow; Alt+← is Back (Alt+→ right to left). The flow is the form
// round it, else the page.
"use client";

import * as stylex from "@stylexjs/stylex";
import { TooltipTrigger as TriggerPrimitive } from "@ui-sdk/react/tooltip";
import { useEffect, useEffectEvent, useRef } from "react";
import type { ReactElement, ReactNode, RefObject } from "react";

import { useI18n } from "../lib/i18n";
import { ArrowLeftIcon, ArrowRightIcon, Icon } from "../lib/icons";
import { focusRing, visuallyHidden } from "../lib/styles";
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
import type { LayoutStyle, Orientation } from "../lib/utils";
import { iconVars, motionVars } from "../lib/vars.stylex";
import { Button } from "./button";
import { Progress } from "./progress";
import { Spinner } from "./spinner";
import { stepMarker } from "./stepper.stylex";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/** Where a step is: done, the one you are on, still to come, or failed. */
export type StepperStatus = "complete" | "active" | "pending" | "error";

/** One step. */
export interface StepperStep {
  /** Its name, in a word or two ("Members"). */
  label: string;
  /** A line under the name, shown when the stepper runs down. */
  description?: ReactNode;
  /**
   * Its status, when it is not what `value` says: `error` for a step that stopped. Otherwise the
   * steps before `value` are complete, and the ones after it pending.
   */
  status?: StepperStatus;
}

/** Every prop a Stepper takes. */
export interface StepperProps {
  /** The steps, in order. */
  steps: readonly StepperStep[];
  /**
   * The step you are on, counted from 0. Past the last step, every step is done.
   * @default 0
   */
  value?: number;
  /**
   * Called with a done step's index when the person presses it, to go back to it (with `reached`,
   * any step up to it). Given, every done step is a button (a 44px target); left out, the stepper
   * only shows progress.
   */
  onValueChange?: (index: number) => void;
  /**
   * `horizontal` runs across, the names under their marks; `vertical` runs down, with room for each
   * step's description.
   * @default "horizontal"
   */
  orientation?: Orientation;
  /** What the steps are for, for a screen reader ("Setting up the workspace"). */
  "aria-label"?: string;
  /**
   * Shows each step's name beside its mark. `false` shows the marks alone: each step's name is its
   * name for a screen reader and its tooltip on hover and on focus (every step takes focus), and nothing else changes. Across, the marks stand
   * a calm pitch apart instead of filling the width (a `style` width still wins). On a phone the row
   * still folds to the marks and "Step 2 of 9 · Members".
   * @default true
   */
  showLabels?: boolean;
  /**
   * The furthest step the person has reached, counted from 0. Given with `onValueChange`, every
   * step up to it is a button, forward as well as back (a 44px target), and the steps after it are
   * not. A step after the current one that has been reached was done: its mark is drawn, and said,
   * as done, while the line stays lit only to the current step. Left out, only a done step is a way
   * back.
   */
  reached?: number;
  /**
   * The current step is in progress: its ring gives way to the working light, travelling the line
   * toward the next step (ambient and slow; still with reduced motion). Leave it out, or false, when
   * the step waits on the person.
   * @default false
   */
  loading?: boolean;
  /** Layout only: where it sits, and how wide it is. */
  style?: LayoutStyle;
}

const FORCED = media.forcedColors;
const REDUCED = media.reducedMotion;
const PHONE = media.maxSm;

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

/** How far a line between two steps stops short of each step's middle: past the current step's
 * ring, and the line's own gap. */
const LINE_OFF = `(${size.stepperDotActive} / 2 + ${size.stepperRingGap} + ${size.stepperRing} + ${space.stepperLineGap})`;
/** The room the current step's ring is given, across: the mark is as tall as it. The ring is 19px
 * (the dot, and its gap and stroke on both sides); its room is a pixel more, an even number as the
 * dot (8 or 10px) and the line (2px) are, so each stands on whole pixels about one middle: an odd
 * room would put that middle half a pixel off the dot's and the line's. */
const ROOM = `(${size.stepperDotActive} + 2 * (${size.stepperRingGap} + ${size.stepperRing}) + 1px)`;
/** Across, where the dots stand in their column: the start edge, the name under it from the same
 * edge; the middle of the dot, from the column's start and top. */
const DOT_X = `(${size.stepperDotActive} / 2)`;
const DOT_Y = `(${ROOM} / 2)`;
const MARK = size.stepperMark;

// Down, the room between one step and the next: a gap between equal rows, not padding under each
// step, so the last step has nothing empty under it. What is drawn behind the steps is placed by
// the row and this gap.
const GAP_DOWN = space["5"];
/** A row's height down, from the whole: the rows share what the gaps leave. */
const rowDown = (count: number) =>
  `((100% - ${count - 1} * ${GAP_DOWN}) / ${count})`;

const styles = stylex.create({
  root: {
    // -1 right to left: what moves across moves the other way.
    "--stepper-sign": { default: "1", ":dir(rtl)": "-1" },
    [iconVars.stroke]: size.iconStroke,
    position: "relative",
    minWidth: 0,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  // What the caller places: the stepper's own box, round the drawing (root).
  frame: { minWidth: 0 },
  // The marks alone, across: a calm pitch for each step instead of the whole width, never wider
  // than what holds it (on a phone the steps share it, as with their names). From the first mark's
  // start edge to the last one's end edge; a phone keeps the whole width.
  pitch: (count: number) => ({
    width: {
      default: `calc(${count - 1} * ${size.stepperPitch} + ${ROOM})`,
      [PHONE]: "100%",
    },
    maxWidth: "100%",
  }),
  // The drawing reaches half a pitch past the frame on each side, less half a mark, so each mark
  // stands in the middle of its pitch and the first is flush with the content. On a phone the row is
  // the whole width, each dot on its column's start edge.
  pitchRoot: {
    marginInline: {
      default: `calc((${ROOM} - ${size.stepperPitch}) / 2)`,
      [PHONE]: 0,
    },
  },
  // 1 where the dots stand in their columns' middle, 0 on their start edge.
  centre: {
    "--stepper-centre": { default: "1", [PHONE]: "0" },
  },
  stepMarks: {
    paddingInlineStart: { default: space["1"], [PHONE]: 0 },
    paddingInlineEnd: { default: space["1"], [PHONE]: space["3"] },
  },
  hitMarks: {
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
    paddingInline: space["1"],
  },
  // Across with names: each step starts on its column's start edge, the row flush with the
  // content's; a little room at the end keeps a wrapped name off the next.
  stepAcrossStart: {
    paddingInlineStart: 0,
    paddingInlineEnd: space["3"],
  },
  // ---- What a step holds, and what a person presses when it can be gone back to ----
  hit: {
    position: "relative",
    display: "grid",
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: `calc(${radius.base} / 2)`,
    cornerShape: radius.shape,
    backgroundColor: "transparent",
    color: "inherit",
    font: "inherit",
    textAlign: "inherit",
  },
  hitAcross: {
    justifyItems: "center",
    alignContent: "start",
    // Across a phone the names fold away: no gap is kept for them under the marks.
    rowGap: { default: space["2"], [PHONE]: 0 },
    textAlign: "center",
  },
  hitAcrossStart: {
    justifyItems: "start",
    textAlign: "start",
  },
  // The mark across: as wide as the current dot and as tall as its ring's room, at the start of the
  // column.
  markAcross: {
    width: size.stepperDotActive,
    height: `calc${ROOM}`,
  },
  // The marks alone: as wide as the ring's room too, so the dot stands in the middle of its pitch
  // and the line as far from the step before as from the step after. On a phone, as with names.
  markPitched: {
    width: { default: `calc${ROOM}`, [PHONE]: size.stepperDotActive },
  },
  // A finger needs 44px: an unseen area round the press makes up what it is shorter, without making
  // the row taller than what it shows.
  target: {
    position: "absolute",
    insetInline: 0,
    insetBlock: `min(0px, calc((100% - ${size.tapTarget}) / 2))`,
  },
  // The marks alone: a column may be narrower than a finger (nine steps on a phone), so the target
  // is 44px wide round the mark's middle as well.
  targetWide: {
    insetInline: `min(0px, calc((100% - ${size.tapTarget}) / 2))`,
  },
  // Down, the press reaches a little past the round mark on every side, given back by the margin, so
  // its target holds the mark and the words and nothing moves; its ring is on the mark.
  hitDown: {
    gridTemplateColumns: `${MARK} minmax(0, 1fr)`,
    columnGap: space["3"],
    alignItems: "start",
    textAlign: "start",
    marginInline: `calc(-1 * ${space["2"]})`,
    marginBlock: `calc(-1 * ${space["1"]})`,
    paddingInline: space["2"],
    paddingBlock: space["1"],
  },
  pressable: {
    cursor: "pointer",
    appearance: "none",
    backgroundColor: {
      default: "transparent",
      ":hover": colors.accentHighlight,
    },
    transitionProperty: "background-color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  // The line runs through the steps from mark to mark: a box round a whole step would be crossed by
  // it. The press shows on its mark instead, the node the line joins: the ring round the mark, a soft
  // fill behind it under the pointer, and the name in ink.
  pressOnMark: {
    outline: "none",
    backgroundColor: "transparent",
  },
  markPress: {
    borderRadius: radius.circle,
    cornerShape: "round",
    outline: {
      default: "none",
      [stylex.when.ancestor(":focus-visible", stepMarker)]: {
        default: `${size.ringWidth} solid ${colors.ring}`,
        [FORCED]: `calc(2 * ${size.lineStrong}) solid Highlight`,
      },
    },
    outlineOffset: size.ringOffset,
    boxShadow: {
      default: "none",
      [stylex.when.ancestor(":hover", stepMarker)]:
        `0 0 0 ${space["1"]} ${colors.accentHighlight}`,
    },
    transitionProperty: "box-shadow",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  // The marks alone: a step that is not a button still takes focus for its tooltip; its ring is on
  // its mark, with no hover fill (nothing to press).
  markFocus: {
    borderRadius: radius.circle,
    cornerShape: "round",
    outline: {
      default: "none",
      [stylex.when.ancestor(":focus-visible", stepMarker)]: {
        default: `${size.ringWidth} solid ${colors.ring}`,
        [FORCED]: `calc(2 * ${size.lineStrong}) solid Highlight`,
      },
    },
    outlineOffset: size.ringOffset,
  },
  nameHover: {
    color: {
      default: null,
      [stylex.when.ancestor(":hover", stepMarker)]: colors.foreground,
    },
  },
  // ---- The words ----
  words: {
    display: "grid",
    rowGap: space["1"],
    minWidth: 0,
    maxWidth: "100%",
  },
  wordsDown: {
    // The name stands level with the middle of its mark.
    paddingBlockStart: `calc((${MARK} - ${font.textSmLine}) / 2)`,
  },
  // A name wraps on a narrow row; it is never cut short.
  name: {
    minWidth: 0,
    overflowWrap: "break-word",
    textWrap: "balance",
    transitionProperty: "color",
    transitionDuration: motionVars.mark,
    transitionTimingFunction: duration.ease,
  },
  // Across a phone, the names give way to the one line under the row; still read.
  nameFolds: {
    position: { default: null, [PHONE]: "absolute" },
    width: { default: null, [PHONE]: 1 },
    height: { default: null, [PHONE]: 1 },
    margin: { default: null, [PHONE]: -1 },
    clipPath: { default: null, [PHONE]: "inset(50%)" },
  },
  pending: { color: colors.mutedForeground },
  active: { color: colors.foreground, fontWeight: font.weightMedium },
  complete: { color: colors.bodyForeground },
  error: { color: colors.destructive, fontWeight: font.weightMedium },
  description: {
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
    textWrap: "pretty",
  },
  fold: {
    display: { default: "none", [PHONE]: "block" },
    marginBlockStart: space["2"],
    overflowWrap: "break-word",
    textWrap: "balance",
    textAlign: "start",
    color: colors.foreground,
  },
  foldCount: { color: colors.mutedForeground },
  // ---- The mark: one box, the same size in every state ----
  mark: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: MARK,
    height: MARK,
  },
  // A small dot in the middle of the mark's box, the same box in every state. In forced colours the
  // marks keep their own system colours and their shapes (filled, open, ringed, square) tell the
  // states apart without colour.
  dot: {
    boxSizing: "border-box",
    width: size.stepperDot,
    height: size.stepperDot,
    borderRadius: radius.circle,
    // Every dot has the same edge; its colour, with the fill, says the state, so a change of state
    // is a change of colour and size and nothing blinks out on the way.
    borderWidth: size.stepperRing,
    borderStyle: "solid",
    // The current step's one quiet ring is the dot's own outline, not a second box: a browser sets
    // each box's edges on whole device pixels by itself, so two boxes of unlike size (a 19px ring
    // round a 10px dot) land half a pixel apart, while an outline is drawn from the dot's own edges
    // and is about its middle at every pixel density and zoom. It takes no room, so the mark's box
    // is the same in every state.
    outlineWidth: size.stepperRing,
    outlineStyle: "solid",
    outlineColor: "transparent",
    outlineOffset: size.stepperRingGap,
    forcedColorAdjust: "none",
    transitionProperty:
      "width, height, background-color, border-color, border-radius, outline-color",
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
  },
  dotPending: {
    backgroundColor: "transparent",
    borderColor: { default: colors.mutedForeground, [FORCED]: "CanvasText" },
  },
  dotComplete: {
    backgroundColor: { default: colors.mintDeep, [FORCED]: "CanvasText" },
    borderColor: { default: colors.mintDeep, [FORCED]: "CanvasText" },
  },
  dotActive: {
    width: size.stepperDotActive,
    height: size.stepperDotActive,
    backgroundColor: { default: colors.mintDeep, [FORCED]: "Highlight" },
    borderColor: { default: colors.mintDeep, [FORCED]: "Highlight" },
  },
  dotError: {
    width: size.stepperDotActive,
    height: size.stepperDotActive,
    borderRadius: radius.hairline,
    backgroundColor: { default: colors.destructive, [FORCED]: "CanvasText" },
    borderColor: { default: colors.destructive, [FORCED]: "CanvasText" },
  },
  // The current step's ring shows; it gives way to the working light.
  dotRinged: {
    outlineColor: {
      default: `color-mix(in oklch, ${colors.mintDeep} 55%, transparent)`,
      [FORCED]: "Highlight",
    },
  },
  // ---- What lies behind the steps: the line, its fill, the light ----
  behind: {
    position: "absolute",
    pointerEvents: "none",
  },
  // One line between each two steps, stopping short of both: a hairline, or solid in the value
  // colour once the step before it is done.
  segAcross: (index: number, count: number, dot: string) => ({
    insetInlineStart: `calc(${(index / count) * 100}% + ${dot} + ${LINE_OFF})`,
    width: `calc(100% / ${count} - 2 * ${LINE_OFF})`,
    top: `calc(${DOT_Y} - ${size.stepperLine} / 2)`,
    height: size.stepperLine,
  }),
  segDown: (index: number, count: number) => ({
    insetInlineStart: `calc(${MARK} / 2 - ${size.stepperLine} / 2)`,
    width: size.stepperLine,
    top: `calc(${index} * (${rowDown(count)} + ${GAP_DOWN}) + ${MARK} / 2 + ${LINE_OFF})`,
    height: `calc(${rowDown(count)} + ${GAP_DOWN} - 2 * ${LINE_OFF})`,
  }),
  seg: {
    display: "grid",
    placeItems: "center",
  },
  // The hairline drawn in the middle of the segment's room; once done it fills that room.
  segLine: {
    borderRadius: radius.full,
    backgroundColor: { default: colors.border, [FORCED]: "GrayText" },
    forcedColorAdjust: "none",
    transitionProperty: "background-color, width, height",
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
  },
  // One weight for the whole line: the colour alone says what is done.
  segLineAcross: { width: "100%", height: size.stepperLine },
  segLineDown: { width: size.stepperLine, height: "100%" },
  segDone: {
    backgroundColor: { default: colors.mintDeep, [FORCED]: "CanvasText" },
  },
  // The mover: one step wide (or tall), so moving it by 100% of itself moves it one step, and on the
  // last step it still ends where the stepper does (it never makes the page scroll).
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
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
  },
  out: { opacity: 0 },
  // The working light's room: the line from the current step to the next, inside the mover, so an
  // advance carries it to the next stretch. Hidden in forced colours: the marks carry the state.
  travelRoomAcross: (dot: string) => ({
    insetInlineStart: `calc(${dot} + ${LINE_OFF})`,
    width: `calc(100% - 2 * ${LINE_OFF})`,
    top: `calc(${DOT_Y} - ${size.stepperLine} / 2)`,
    height: size.stepperLine,
  }),
  travelRoomDown: {
    insetInlineStart: `calc(${MARK} / 2 - ${size.stepperLine} / 2)`,
    width: size.stepperLine,
    top: `calc(${MARK} / 2 + ${LINE_OFF})`,
    height: `calc(100% + ${GAP_DOWN} - 2 * ${LINE_OFF})`,
  },
  travelRoom: {
    position: "absolute",
    overflow: "hidden",
    borderRadius: radius.full,
    display: { default: null, [FORCED]: "none" },
  },
  // The stretch itself: 40% of the line. Still under reduced motion, a short lit stretch at rest at
  // the start of the line.
  travel: {
    position: "absolute",
    animationDuration: duration.stepperTravel,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  travelAcross: {
    insetBlock: 0,
    insetInlineStart: 0,
    width: "40%",
    backgroundImage: colors.stepperTravelAcross,
    animationName: { default: travelAcross, [REDUCED]: "none" },
  },
  travelDown: {
    insetInline: 0,
    top: 0,
    height: "40%",
    backgroundImage: colors.stepperTravelDown,
    animationName: { default: travelDown, [REDUCED]: "none" },
  },
  // While the light is out, nothing travels that is not seen.
  travelStill: { animationPlayState: "paused" },
});

const nameStyles = {
  pending: styles.pending,
  active: styles.active,
  complete: styles.complete,
  error: styles.error,
} as const;
const dotStyles = {
  pending: styles.dotPending,
  active: styles.dotActive,
  complete: styles.dotComplete,
  error: styles.dotError,
} as const;

/** A step's status: its own, or where it stands from `value`. */
const statusOf = (
  step: StepperStep,
  index: number,
  current: number
): StepperStatus => {
  if (step.status !== undefined) {
    return step.status;
  }
  if (index < current) {
    return "complete";
  }
  return index === current ? "active" : "pending";
};

/**
 * Which steps a person may press: a done step, to go back to it; and with `reached`, every step up
 * to the furthest one reached, forward as well as back, but never the step they are on.
 */
const canPress = (
  status: StepperStatus,
  index: number,
  current: number,
  reached: number | undefined
) =>
  status === "complete" ||
  (reached !== undefined && index !== current && index <= reached);

/**
 * How a step is drawn and said: a step still to come that the person has reached and come back from
 * was done, so it is drawn and said as done; the line's own fill still follows `value`.
 */
const shownStatus = (
  status: StepperStatus,
  index: number,
  current: number,
  reached: number | undefined
): StepperStatus =>
  status === "pending" &&
  reached !== undefined &&
  index > current &&
  index <= reached
    ? "complete"
    : status;

/** The ring a step's mark answers with: a press's (hover and focus), focus alone, or none. */
type Ring = "press" | "focus" | undefined;

const ringOf = (ring: Ring) => {
  if (ring === "press") {
    return styles.markPress;
  }
  return ring === "focus" && styles.markFocus;
};

/** A step's mark: the dot, round the current one its ring while it is not at work. */
const Mark = ({
  status,
  ring,
  loading,
  across,
  pitched,
}: {
  status: StepperStatus;
  ring: Ring;
  loading: boolean;
  across: boolean;
  pitched: boolean;
}) => (
  <span
    aria-hidden="true"
    data-status={status}
    {...stylex.props(
      styles.mark,
      across && styles.markAcross,
      pitched && styles.markPitched,
      ringOf(ring)
    )}
  >
    <span
      {...stylex.props(
        styles.dot,
        dotStyles[status],
        status === "active" && !loading && styles.dotRinged
      )}
    />
  </span>
);

/** The line in its stretches, and the working light on the one after the current step. */
const Behind = ({
  across,
  count,
  current,
  statuses,
  loading,
  centred,
}: {
  across: boolean;
  count: number;
  current: number;
  statuses: readonly StepperStatus[];
  loading: boolean;
  centred: boolean;
}) => {
  const at = Math.min(Math.max(current, 0), Math.max(count - 1, 0));
  const lit = current < count && statuses[current] !== "error";
  // There only while the current step is in progress and has a next step to travel to.
  const travelling = loading && lit && at < count - 1;
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
      {statuses.slice(0, -1).map((status, index) => {
        const done = status === "complete";
        return (
          <span
            // Each stretch sits between two fixed steps: its index is its place.
            key={`line-${index}`}
            aria-hidden="true"
            data-done={done ? "" : undefined}
            {...stylex.props(
              styles.behind,
              styles.seg,
              across
                ? styles.segAcross(index, count, lineDot)
                : styles.segDown(index, count)
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
          across ? styles.moverAcross(at, count) : styles.moverDown(at, count),
          !travelling && styles.out
        )}
      >
        <span
          {...stylex.props(
            styles.travelRoom,
            across ? styles.travelRoomAcross(lightDot) : styles.travelRoomDown
          )}
        >
          <span
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
 * the name the step already says, so it is not made its description: a screen reader is not told it
 * twice. A step that is not a button still takes focus, so the keyboard reaches its name.
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
  status: StepperStatus;
  /** How its status is said, after its name. */
  statusWords: string;
  across: boolean;
  showLabels: boolean;
  loading: boolean;
  /** Pressed, it goes to this step: given when the step can be pressed. */
  onSelect: ((index: number) => void) | undefined;
  /** Across with names: on its column's start edge. */
  start: boolean;
  /** The marks alone, across: in its column's middle, but on a phone. */
  marks: boolean;
}

/** One step: its mark and its words; a button when it can be pressed; with the marks alone, its tooltip. */
const StepItem = ({
  step,
  index,
  status,
  statusWords,
  across,
  showLabels,
  loading,
  onSelect,
  start,
  marks,
}: StepItemProps) => {
  const pressable = onSelect !== undefined;
  const words = (
    <span
      {...stylex.props(
        styles.words,
        !across && styles.wordsDown,
        !showLabels && visuallyHidden
      )}
    >
      <span
        {...stylex.props(
          styles.name,
          nameStyles[status],
          across && showLabels && styles.nameFolds,
          pressable && styles.nameHover
        )}
      >
        {step.label}
        <span {...stylex.props(visuallyHidden)}>, {statusWords}</span>
      </span>
      {!across && step.description !== undefined && (
        <span {...stylex.props(styles.description)}>{step.description}</span>
      )}
    </span>
  );
  let ring: Ring;
  if (pressable) {
    ring = "press";
  } else if (!showLabels) {
    ring = "focus";
  }
  const inside = (
    <>
      {pressable && (
        <span
          aria-hidden="true"
          {...stylex.props(styles.target, !showLabels && styles.targetWide)}
        />
      )}
      <Mark
        status={status}
        ring={ring}
        loading={loading}
        across={across}
        pitched={marks}
      />
      {words}
    </>
  );
  const layout = across ? styles.hitAcross : styles.hitDown;
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
            marks && styles.hitMarks,
            styles.pressable,
            focusRing,
            styles.pressOnMark
          )}
        >
          {inside}
        </button>
      );
    }
    if (!showLabels) {
      return (
        <span
          {...lent}
          {...stylex.props(
            stepMarker,
            styles.hit,
            layout,
            marks && styles.hitMarks,
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
      aria-current={status === "active" ? "step" : undefined}
      {...stylex.props(
        styles.step,
        across && styles.stepAcross,
        start && styles.stepAcrossStart,
        marks && styles.stepMarks
      )}
    >
      <Tipped
        name={step.label}
        tipped={!showLabels}
        focusable={!pressable}
        draw={draw}
      />
    </li>
  );
};

/** Across a phone: the names give way to one line, "Step 2 of 4 · Members", or the finished words. */
const Fold = ({
  here,
  count,
  status,
  finished,
  errorWords,
}: {
  here: string | undefined;
  count: string;
  status: StepperStatus | undefined;
  finished: string;
  errorWords: string;
}) => (
  <div aria-hidden="true" {...stylex.props(styles.fold)}>
    {here === undefined ? (
      finished
    ) : (
      <>
        <span {...stylex.props(styles.foldCount)}>{count} · </span>
        {here}
        {/* A failed step says so in words too, not by its red mark alone. */}
        {status === "error" && (
          <span {...stylex.props(styles.error)}>{` · ${errorWords}`}</span>
        )}
      </>
    )}
  </div>
);

/** Progress through named steps: an ordered list of marks on one line. */
export const Stepper = ({
  steps,
  value: current = 0,
  onValueChange,
  orientation = "horizontal",
  "aria-label": label,
  showLabels = true,
  reached,
  loading = false,
  style,
}: StepperProps) => {
  const words = useI18n().stepper;
  const across = orientation === "horizontal";
  const count = steps.length;
  const statuses = steps.map((step, index) => statusOf(step, index, current));
  const here = steps[current];
  const where =
    here === undefined
      ? words.finished
      : words.current(current + 1, count, here.label);
  // Across, the steps start on their column's edge, under their names; with the marks alone each
  // mark stands in its column's middle, a pitch apart, but on a phone.
  const marks = across && !showLabels;
  // Where it stands, said as it moves; at first the list says it.
  const said = useRef(where);
  useEffect(() => {
    if (said.current !== where) {
      said.current = where;
      announce(where);
    }
  }, [where]);
  return (
    <div
      data-slot="stepper"
      data-loading={loading ? "" : undefined}
      data-show-labels={showLabels ? "" : undefined}
      {...stylex.props(styles.frame, marks && styles.pitch(count), style)}
    >
      <div
        {...stylex.props(
          styles.root,
          marks && styles.pitchRoot,
          marks && styles.centre
        )}
      >
        <ol
          aria-label={label}
          {...stylex.props(
            styles.list,
            across ? styles.columns(count) : styles.rows
          )}
        >
          {steps.map((step, index) => {
            const status = statuses[index] ?? "pending";
            // Reached and come back from: drawn and said as done; the line behind still follows `value`.
            const shown = shownStatus(status, index, current, reached);
            return (
              <StepItem
                key={`${index}-${step.label}`}
                step={step}
                index={index}
                status={shown}
                statusWords={words.states[shown]}
                across={across}
                showLabels={showLabels}
                loading={loading}
                onSelect={
                  canPress(status, index, current, reached)
                    ? onValueChange
                    : undefined
                }
                start={across && showLabels}
                marks={marks}
              />
            );
          })}
        </ol>
        <Behind
          across={across}
          count={count}
          current={current}
          statuses={statuses}
          loading={loading}
          centred={marks}
        />
        {across && (
          <Fold
            here={here?.label}
            count={words.count(current + 1, count)}
            status={statuses[current]}
            finished={words.finished}
            errorWords={words.states.error}
          />
        )}
      </div>
    </div>
  );
};

// ---- StepperNav ------------------------------------------------------------------------------------

/** Every prop a StepperNav takes. */
export interface StepperNavProps {
  /**
   * `bar`: the quiet bar at the top of the flow, Back and Next as ghost arrows either side of the
   * progress, the answer below with the page to itself. `footer`: the flow's foot, Next its one
   * action with its word.
   * @default "footer"
   */
  variant?: "bar" | "footer";
  /** The step the flow is on, counted from 0. */
  step: number;
  /** How many steps the flow has. */
  total: number;
  /** Goes back a step. Without it there is no Back; on the first step it is hidden, its room kept. */
  onBack?: () => void;
  /** Goes on. Without it, Next is its form's submit button. */
  onNext?: () => void;
  /**
   * Whether Next submits its form or is a plain button.
   * @default "submit" without `onNext`, else "button"
   */
  nextType?: "submit" | "button";
  /** What Next says on the last step, the words for what it does ("Create agent"), with no arrow. */
  finishLabel?: string;
  /**
   * Next waits: for an answer, or a check. With `disabledReason` it keeps its place in the keys and
   * says why in its tooltip.
   * @default false
   */
  disabled?: boolean;
  /** Why Next waits, in a few words ("Choose one to go on"): its tooltip, and its description. */
  disabledReason?: string;
  /**
   * Next is working: a Spinner in it, and it cannot be pressed again.
   * @default false
   */
  loading?: boolean;
  /**
   * "Step 3 of 7" shown with the progress, not only said with it.
   * @default false
   */
  showCount?: boolean;
  /** More before Next, at the footer's end (a Skip): small ghost buttons. */
  extra?: ReactNode;
  /**
   * Its keys: Enter, Mod+Enter and Alt+←. Off where the page has its own.
   * @default true
   */
  keys?: boolean;
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

const navStyles = stylex.create({
  // Three columns: Back's, the progress's (all the room), and Next's.
  nav: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    alignItems: "center",
    gap: space["3"],
    width: "100%",
    minWidth: 0,
  },
  footer: {
    gap: { default: space["4"], [PHONE]: space["3"] },
  },
  start: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    minWidth: 0,
  },
  end: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space["2"],
  },
  // On the first step Back is not there to press, but its room is: the nav stays where it stands.
  kept: { visibility: "hidden", opacity: 0, pointerEvents: "none" },
  // The footer's Back with its word, and the arrow alone on a phone: one shows at a time.
  wide: { display: { default: "inline-flex", [PHONE]: "none" } },
  narrow: { display: { default: "none", [PHONE]: "inline-flex" } },
  // The progress takes the room; the count, when shown beside the bar, at its end.
  middle: {
    display: "flex",
    alignItems: "center",
    gap: space["3"],
    minWidth: 0,
  },
  progress: { display: "flex", flexGrow: 1, minWidth: 0 },
  count: {
    flexShrink: 0,
    color: colors.mutedForeground,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
});

/** Whether an Enter at this element is the field's or a button's own, not the flow's. */
const ownsEnter = (
  target: EventTarget | null,
  form: HTMLFormElement | null
) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (
    target.isContentEditable ||
    target.closest(
      "textarea, button, a[href], select, [role=button], [role=combobox], [role=menuitem], [role=option], [role=tab]"
    ) !== null
  ) {
    return true;
  }
  // In a form, Enter in a field already goes on: the form sends itself through Next.
  return form !== null && target instanceof HTMLInputElement;
};

/** A guided flow's keys, on its flow (the form round the nav, else the page): Next and Back. */
const useStepKeys = (
  on: boolean,
  nav: RefObject<HTMLDivElement | null>,
  back: () => void
) => {
  // The latest Back, without listening again each time the caller hands a new one.
  const goBack = useEffectEvent(back);
  useEffect(() => {
    const element = nav.current;
    if (!on || element === null) {
      return () => {
        // Nothing was listened for, so nothing stops.
      };
    }
    const form = element.closest("form");
    const scope: HTMLElement | Document = form ?? element.ownerDocument;
    const press = (event: Event) => {
      if (
        !(event instanceof KeyboardEvent) ||
        event.defaultPrevented ||
        event.isComposing
      ) {
        return;
      }
      const rtl = getComputedStyle(element).direction === "rtl";
      if (event.altKey && event.key === (rtl ? "ArrowRight" : "ArrowLeft")) {
        event.preventDefault();
        goBack();
        return;
      }
      if (event.key !== "Enter" || event.shiftKey || event.altKey) {
        return;
      }
      const anywhere = event.metaKey || event.ctrlKey;
      if (!anywhere && ownsEnter(event.target, form)) {
        return;
      }
      event.preventDefault();
      element.querySelector<HTMLButtonElement>("[data-stepper-next]")?.click();
    };
    scope.addEventListener("keydown", press);
    return () => {
      scope.removeEventListener("keydown", press);
    };
  }, [on, nav]);
};

/** A button with its tooltip, when it has one. */
const WithTooltip = ({
  tip,
  children,
}: {
  tip: string | undefined;
  children: ReactElement;
}) =>
  tip === undefined ? (
    children
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );

/** Back: a ghost arrow in the bar; in the footer its word after the arrow, the arrow alone on a phone. */
const BackButton = ({
  bar,
  first,
  go,
  label,
}: {
  bar: boolean;
  first: boolean;
  go: () => void;
  label: string;
}) => {
  // Two buttons, not one whose word a phone hides: the default size with no word is wider than
  // the icon size's square there.
  const arrow = (
    <WithTooltip tip={label}>
      <Button
        variant={bar ? "ghost" : "outline"}
        size={bar ? "icon-sm" : "icon"}
        aria-label={label}
        disabled={first}
        onClick={go}
      >
        <Icon icon={ArrowLeftIcon} />
      </Button>
    </WithTooltip>
  );
  return (
    <span
      aria-hidden={first || undefined}
      inert={first || undefined}
      {...stylex.props(navStyles.start, first && navStyles.kept)}
    >
      {bar ? (
        arrow
      ) : (
        <>
          <span {...stylex.props(navStyles.wide)}>
            <Button variant="outline" disabled={first} onClick={go}>
              <Icon icon={ArrowLeftIcon} />
              {label}
            </Button>
          </span>
          <span {...stylex.props(navStyles.narrow)}>{arrow}</span>
        </>
      )}
    </span>
  );
};

interface NextButtonProps {
  bar: boolean;
  /** On the last step. */
  last: boolean;
  nextType: "submit" | "button" | undefined;
  onNext: (() => void) | undefined;
  finishLabel: string | undefined;
  disabled: boolean;
  disabledReason: string | undefined;
  loading: boolean;
}

/** Why Next waits, as its tooltip: only when it waits and the reason has words. */
const reasonOf = (disabled: boolean, reason: string | undefined) =>
  disabled && reason !== undefined && reason !== "" ? reason : undefined;

/**
 * Next's press: held, it keeps focus (and its tooltip) but neither goes on nor submits, so neither a
 * press, Enter nor the flow's keys send anything.
 */
const pressOf = (
  { nextType, onNext, disabled, loading }: NextButtonProps,
  reason: string | undefined
) => {
  const held = disabled || loading;
  const type = nextType ?? (onNext === undefined ? "submit" : "button");
  return {
    type: held ? ("button" as const) : type,
    onClick: held ? undefined : onNext,
    disabled: held,
    focusableWhenDisabled: reason !== undefined || loading,
    "aria-busy": loading || undefined,
    "data-stepper-next": "",
  };
};

/** Next: a ghost arrow in the bar, its words on the last step; in the footer the step's one action. */
const NextButton = (props: NextButtonProps) => {
  const { bar, last, finishLabel, disabled, disabledReason, loading } = props;
  const { navNext } = useI18n().stepper;
  const label = last ? (finishLabel ?? navNext) : navNext;
  // The bar's last step is always words; the footer's only when it says what it does.
  const finish = last && (bar || finishLabel !== undefined);
  const reason = reasonOf(disabled, disabledReason);
  const press = pressOf(props, reason);
  if (bar && !finish) {
    return (
      <WithTooltip tip={reason ?? label}>
        <Button {...press} variant="ghost" size="icon-sm" aria-label={label}>
          {loading ? <Spinner /> : <Icon icon={ArrowRightIcon} />}
        </Button>
      </WithTooltip>
    );
  }
  const end = loading ? <Spinner /> : <Icon icon={ArrowRightIcon} />;
  return (
    <WithTooltip tip={bar ? (reason ?? label) : reason}>
      <Button
        {...press}
        variant={bar ? "ghost" : "default"}
        size={bar ? "sm" : "default"}
      >
        {loading && finish && <Spinner />}
        {label}
        {!finish && end}
      </Button>
    </WithTooltip>
  );
};

/** How far through: the thin bar, said as "Step 3 of 7", and the words shown when asked. */
const HowFar = ({
  bar,
  step,
  total,
  showCount,
}: {
  bar: boolean;
  step: number;
  total: number;
  showCount: boolean;
}) => {
  const said = useI18n().stepper.count(step + 1, total);
  return (
    <span {...stylex.props(navStyles.middle)}>
      <span {...stylex.props(navStyles.progress)}>
        <Progress
          label={said}
          value={Math.round(((step + 1) / total) * 100)}
          size="sm"
          showLabel={!bar && showCount}
          getAriaValueText={() => said}
        />
      </span>
      {bar && showCount ? (
        <span aria-hidden="true" {...stylex.props(navStyles.count)}>
          {said}
        </span>
      ) : null}
    </span>
  );
};

/** A guided flow's Back, how far through, and Next: a quiet bar at its top, or its foot. */
export const StepperNav = ({
  variant = "footer",
  step,
  total,
  onBack,
  onNext,
  nextType,
  finishLabel,
  disabled = false,
  disabledReason,
  loading = false,
  showCount = false,
  extra,
  keys = true,
  style,
}: StepperNavProps) => {
  const { navBack } = useI18n().stepper;
  const nav = useRef<HTMLDivElement>(null);
  const bar = variant === "bar";
  const first = step === 0;
  const goBack = () => {
    if (onBack !== undefined && !first) {
      onBack();
    }
  };
  useStepKeys(keys, nav, goBack);
  return (
    <div
      ref={nav}
      data-slot="stepper-nav"
      data-variant={variant}
      {...stylex.props(navStyles.nav, !bar && navStyles.footer, style)}
    >
      {onBack === undefined ? (
        <span />
      ) : (
        <BackButton bar={bar} first={first} go={goBack} label={navBack} />
      )}
      <HowFar bar={bar} step={step} total={total} showCount={showCount} />
      <span {...stylex.props(navStyles.end)}>
        {bar ? null : extra}
        <NextButton
          bar={bar}
          last={step >= total - 1}
          nextType={nextType}
          onNext={onNext}
          finishLabel={finishLabel}
          disabled={disabled}
          disabledReason={disabledReason}
          loading={loading}
        />
      </span>
    </div>
  );
};
