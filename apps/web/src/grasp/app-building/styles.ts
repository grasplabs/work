// How App building is drawn: the stage, the pieces in each of the three looks, the cursors, and
// the moves. Only transform and opacity ever move; every move is a token's length, 300ms at most.
// The dither is a still background (a dot pattern), never redrawn. Every value is a token.
import * as stylex from "@stylexjs/stylex";

import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { buildVars as v } from "./app-building.stylex";

const REDUCED = media.reduced;
const FORCED = media.forced;
const SIGN = "var(--grasp-build-sign, 1)";

// When a piece comes in within its step: once its cursor has arrived and pressed.
const PRESS = `calc(${grasp.appBuildingBeat} * 0.42)`;
const after = (beats: number) =>
  `calc(${PRESS} + ${grasp.durationStagger} * ${beats})`;

// The dither: one dot in every square of the grid, a still background.
const dither = (colour: string) =>
  `radial-gradient(circle at center, ${colour} 0.9px, transparent 1.2px)`;

// The clock: nothing moves; each of its rounds is one step of the build (app-building.tsx).
const tick = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 0 },
});
// A piece, or a line in it, coming in where the cursor pressed.
const appear = stylex.keyframes({
  from: { opacity: 0, transform: "scale(0.94)" },
  to: { opacity: 1, transform: "none" },
});
// What is in a piece settles with its surface, and never fades as a whole: each line fades for
// itself, so nothing moves inside something that cannot be seen (check-hidden-motion).
const settle = stylex.keyframes({
  from: { transform: "scale(0.94)" },
  to: { transform: "none" },
});
const draw = stylex.keyframes({
  from: { opacity: 0, transform: "scaleX(0.3)" },
  to: { opacity: 1, transform: "none" },
});
const grow = stylex.keyframes({
  from: { transform: "scaleY(0)" },
  to: { transform: "none" },
});
// The ring a press leaves under a cursor's tip.
const ripple = stylex.keyframes({
  from: { opacity: 0.6, transform: "scale(0.3)" },
  to: { opacity: 0, transform: "scale(1.6)" },
});
// Half of the UI's duration: what each half of the hand-over takes.
const HALF = `calc(${simply.ui} / 2)`;

// The app coming in, once the stage has left.
const appIn = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

// The stage crossing out to the app.
const cross = stylex.keyframes({
  from: { opacity: 1, transform: "none" },
  to: { opacity: 0, transform: "scale(0.98)" },
});

export const styles = stylex.create({
  // The whole: the stage and, once built, the app in the same place.
  root: {
    position: "relative",
    display: "grid",
    gridTemplateAreas: '"all"',
    gridTemplateColumns: "minmax(0, 1fr)",
    gridTemplateRows: "minmax(0, 1fr)",
    width: "100%",
    height: "100%",
    minHeight: grasp.appBuildingMinHeight,
  },
  stage: {
    "--grasp-build-sign": { default: "1", ":dir(rtl)": "-1" },
    gridArea: "all",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflow: "hidden",
  },
  paused: { [v.play]: "paused" },
  // The hand-over is one move in two halves, each half of the UI's duration: the stage leaves, and
  // only then the app arrives. The two are never on screen together: two whole pictures fading
  // through each other in one place read as a smear.
  crossing: {
    pointerEvents: "none",
    animationName: cross,
    animationDuration: HALF,
    animationTimingFunction: grasp.ease,
    animationFillMode: "forwards",
  },
  app: { gridArea: "all", minWidth: 0, minHeight: 0 },
  arriving: {
    animationName: appIn,
    animationDuration: HALF,
    animationTimingFunction: grasp.ease,
    animationFillMode: "backwards",
  },
  // The drawing: decorative, so hidden from a screen reader.
  canvas: {
    position: "relative",
    flexGrow: 1,
    minHeight: 0,
    overflow: "hidden",
    // Its colours are set for forced colours below, so they are kept as set.
    forcedColorAdjust: "none",
  },
  // The line under it that says the step, quietly.
  step: {
    margin: 0,
    paddingBlock: grasp.space2,
    paddingInline: grasp.space4,
    minHeight: grasp.textSmLine,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
    textAlign: "center",
    overflowWrap: "anywhere",
  },
  // No step given: the live region stays, ready to speak, but takes no room.
  stepEmpty: { paddingBlock: 0, minHeight: 0 },
  clock: {
    position: "absolute",
    width: 0,
    height: 0,
    opacity: 0,
    animationName: { default: tick, [REDUCED]: "none" },
    animationDuration: grasp.appBuildingBeat,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    animationPlayState: v.play,
  },

  // A piece: its place, its move when it changes places, and its fade as the round clears.
  slot: {
    position: "absolute",
    boxSizing: "border-box",
    transitionProperty: "transform, opacity",
    transitionDuration: `${simply.ui}, ${simply.leave}`,
    transitionTimingFunction: grasp.easeInOut,
  },
  at: (x: number, y: number, w: number, h: number) => ({
    insetInlineStart: `${x}%`,
    top: `${y}%`,
    width: `${w}%`,
    height: `${h}%`,
  }),
  moved: (x: number, y: number) => ({
    transform: `translate(calc(${x}% * ${SIGN}), ${y}%)`,
  }),
  cleared: { opacity: 0 },
  // A piece's surface: the one thing of it that fades in.
  surface: {
    animationName: { default: appear, [REDUCED]: "none" },
    animationDuration: simply.ui,
    animationTimingFunction: grasp.ease,
    animationFillMode: "both",
    animationPlayState: v.play,
    animationDelay: PRESS,
    position: "absolute",
    inset: 0,
    boxSizing: "border-box",
    borderRadius: grasp.cornerMark,
    transformOrigin: "32% 42%",
  },
  // What is on it: laid out by kind, settling with the surface.
  piece: {
    animationName: { default: settle, [REDUCED]: "none" },
    animationDuration: simply.ui,
    animationTimingFunction: grasp.ease,
    animationFillMode: "both",
    animationPlayState: v.play,
    position: "absolute",
    inset: 0,
    display: "flex",
    boxSizing: "border-box",
    overflow: "hidden",
    borderRadius: grasp.cornerMark,
    transformOrigin: "32% 42%",
    animationDelay: PRESS,
  },
  // Still: no move at all, the finished interface.
  still: { animationName: "none" },

  // The parts inside a piece, laid out by kind.
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: grasp.space2,
    paddingInline: "3%",
  },
  side: { flexDirection: "column", gap: grasp.space2, padding: grasp.space3 },
  card: {
    flexDirection: "column",
    justifyContent: "center",
    gap: grasp.space2,
    padding: grasp.space3,
  },
  chart: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: "3%",
    padding: grasp.space3,
  },
  table: {
    flexDirection: "column",
    justifyContent: "space-evenly",
    paddingInline: grasp.space3,
    paddingBlock: grasp.space1,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    minHeight: 0,
  },

  // A line, a dot or a bar inside a piece.
  part: {
    animationName: { default: draw, [REDUCED]: "none" },
    animationDuration: simply.ui,
    animationTimingFunction: grasp.ease,
    animationFillMode: "both",
    animationPlayState: v.play,
    animationDelay: after(0),
    flexShrink: 0,
    height: grasp.space2,
    borderRadius: grasp.cornerPill,
    transformOrigin: "0 50%",
  },
  thick: { height: grasp.space4, borderRadius: grasp.cornerMark },
  thin: { height: grasp.space1 },
  dot: { width: grasp.space2, borderRadius: grasp.cornerCircle },
  square: {
    width: grasp.space4,
    height: grasp.space4,
    borderRadius: grasp.cornerMark,
  },
  push: { marginInlineStart: "auto" },
  column: {
    animationName: { default: grow, [REDUCED]: "none" },
    animationDuration: simply.ui,
    animationTimingFunction: grasp.ease,
    animationFillMode: "both",
    animationPlayState: v.play,
    animationDelay: after(0),
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    borderRadius: grasp.cornerMark,
    transformOrigin: "50% 100%",
  },
  w20: { width: "20%" },
  w30: { width: "30%" },
  w45: { width: "45%" },
  w60: { width: "60%" },
  w70: { width: "70%" },
  w85: { width: "85%" },
  h30: { height: "30%" },
  h45: { height: "45%" },
  h55: { height: "55%" },
  h70: { height: "70%" },
  h85: { height: "85%" },
  h100: { height: "100%" },
  at1: { animationDelay: after(1) },
  at2: { animationDelay: after(2) },
  at3: { animationDelay: after(3) },
  at4: { animationDelay: after(4) },
  at5: { animationDelay: after(5) },

  // The cursors: each moves over the whole stage, so its translate is a share of the stage.
  track: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    transitionProperty: "transform, opacity",
    transitionDuration: `${simply.ui}, ${simply.leave}`,
    transitionTimingFunction: grasp.easeInOut,
  },
  to: (x: number, y: number) => ({
    transform: `translate(calc(${x}% * ${SIGN}), ${y}%)`,
  }),
  gone: { opacity: 0 },
  cursor: {
    [iconVars.size]: grasp.iconMd,
    [iconVars.stroke]: grasp.iconStroke,
    position: "absolute",
    top: 0,
    insetInlineStart: 0,
    // The pointer's tip, not its box, stands on the point.
    marginBlockStart: `calc(${grasp.iconMd} * -0.14)`,
    marginInlineStart: `calc(${grasp.iconMd} * -0.14)`,
  },
  ring: {
    position: "absolute",
    top: 0,
    insetInlineStart: 0,
    width: grasp.space4,
    height: grasp.space4,
    marginBlockStart: `calc(${grasp.space2} * -0.5)`,
    marginInlineStart: `calc(${grasp.space2} * -0.5)`,
    borderRadius: grasp.cornerCircle,
    borderWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: "currentColor",
    opacity: 0,
    animationName: { default: ripple, [REDUCED]: "none" },
    animationDuration: simply.ui,
    animationDelay: `calc(${PRESS} - ${grasp.durationStagger})`,
    animationTimingFunction: grasp.ease,
    animationFillMode: "both",
    animationPlayState: v.play,
  },
  tag: {
    position: "absolute",
    top: `calc(${grasp.iconMd} * 0.8)`,
    insetInlineStart: `calc(${grasp.iconMd} * 0.6)`,
    paddingInline: grasp.space2,
    borderRadius: grasp.cornerPill,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    whiteSpace: "nowrap",
    color: { default: grasp.appBuildingOnCursor, [FORCED]: "Canvas" },
  },
  tone0: { color: { default: grasp.pine, [FORCED]: "CanvasText" } },
  tone1: { color: { default: grasp.mintDeep, [FORCED]: "CanvasText" } },
  tone2: { color: { default: grasp.lavender, [FORCED]: "CanvasText" } },
  fill0: { backgroundColor: { default: grasp.pine, [FORCED]: "CanvasText" } },
  fill1: {
    backgroundColor: { default: grasp.mintDeep, [FORCED]: "CanvasText" },
  },
  fill2: {
    backgroundColor: { default: grasp.lavender, [FORCED]: "CanvasText" },
  },
});

// The three looks: the ground, a piece's surface, and the parts inside it.
export const looks = {
  // Soft blocks with a dither on them.
  blocks: stylex.create({
    ground: { backgroundColor: { default: grasp.paper, [FORCED]: "Canvas" } },
    piece: {
      backgroundColor: { default: grasp.appBuildingBlock, [FORCED]: "Canvas" },
      backgroundImage: {
        default: dither(grasp.appBuildingDot),
        [FORCED]: "none",
      },
      backgroundSize: `${grasp.appBuildingDither} ${grasp.appBuildingDither}`,
      outline: {
        default: "none",
        [FORCED]: `${grasp.hairline} solid CanvasText`,
      },
    },
    part: {
      backgroundColor: {
        default: grasp.appBuildingDetail,
        [FORCED]: "GrayText",
      },
    },
    strong: {
      backgroundColor: {
        default: grasp.appBuildingDetail,
        [FORCED]: "CanvasText",
      },
    },
  }),
  // Small parts on the system's own surfaces: raised, with the edge and a low lift.
  parts: stylex.create({
    ground: { backgroundColor: { default: grasp.soft, [FORCED]: "Canvas" } },
    piece: {
      backgroundColor: { default: grasp.raised, [FORCED]: "Canvas" },
      boxShadow: { default: grasp.edge, [FORCED]: "none" },
      outline: {
        default: "none",
        [FORCED]: `${grasp.hairline} solid CanvasText`,
      },
    },
    part: { backgroundColor: { default: grasp.line, [FORCED]: "GrayText" } },
    strong: {
      backgroundColor: {
        default: grasp.appBuildingDetail,
        [FORCED]: "CanvasText",
      },
      backgroundImage: {
        default: dither(grasp.appBuildingDot),
        [FORCED]: "none",
      },
      backgroundSize: `${grasp.appBuildingDither} ${grasp.appBuildingDither}`,
    },
  }),
  // Outlines on a blueprint's grid.
  blueprint: stylex.create({
    ground: {
      backgroundColor: { default: grasp.paper, [FORCED]: "Canvas" },
      backgroundImage: {
        default: `linear-gradient(${grasp.appBuildingGrid} ${grasp.hairline}, transparent ${grasp.hairline}), linear-gradient(90deg, ${grasp.appBuildingGrid} ${grasp.hairline}, transparent ${grasp.hairline})`,
        [FORCED]: "none",
      },
      backgroundSize: `${grasp.space4} ${grasp.space4}`,
    },
    piece: {
      borderWidth: grasp.hairline,
      borderStyle: "dashed",
      borderColor: {
        default: grasp.appBuildingOutline,
        [FORCED]: "CanvasText",
      },
      backgroundImage: {
        default: dither(grasp.appBuildingGrid),
        [FORCED]: "none",
      },
      backgroundSize: `${grasp.appBuildingDither} ${grasp.appBuildingDither}`,
    },
    part: {
      boxSizing: "border-box",
      borderWidth: grasp.hairline,
      borderStyle: "solid",
      borderColor: {
        default: grasp.appBuildingOutline,
        [FORCED]: "CanvasText",
      },
    },
    strong: {
      boxSizing: "border-box",
      borderWidth: grasp.hairline,
      borderStyle: "solid",
      borderColor: {
        default: grasp.appBuildingOutline,
        [FORCED]: "CanvasText",
      },
      backgroundImage: {
        default: dither(grasp.appBuildingOutline),
        [FORCED]: "none",
      },
      backgroundSize: `${grasp.appBuildingDither} ${grasp.appBuildingDither}`,
    },
  }),
};

export const tones = [styles.tone0, styles.tone1, styles.tone2] as const;
export const fills = [styles.fill0, styles.fill1, styles.fill2] as const;
export const delays = [
  null,
  styles.at1,
  styles.at2,
  styles.at3,
  styles.at4,
  styles.at5,
] as const;
