// How App building is drawn: the stage, the pieces as soft blocks with a dither, the cursors, and
// the moves. Only transform and opacity ever move; every move is a token's length, 300ms at most.
// The dither is a still background (a dot pattern), never redrawn. Every value is a token.
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars, motionVars } from "@grasp-os/ui/lib/vars.stylex";
import * as stylex from "@stylexjs/stylex";

import { appBuilding, buildVars as v } from "./app-building.stylex.ts";

const REDUCED = media.reducedMotion;
const FORCED = media.forcedColors;
const SIGN = "var(--app-building-sign, 1)";

// When a piece comes in within its step: once its cursor has arrived and pressed.
const PRESS = `calc(${appBuilding.beat} * 0.42)`;
const after = (beats: number) =>
  `calc(${PRESS} + ${duration.stagger} * ${beats})`;

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
    minHeight: appBuilding.minHeight,
  },
  stage: {
    "--app-building-sign": { default: "1", ":dir(rtl)": "-1" },
    gridArea: "all",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflow: "hidden",
  },
  paused: { [v.play]: "paused" },
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
    paddingBlock: space[2],
    paddingInline: space[4],
    minHeight: font.textSmLine,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
    textAlign: "center",
    overflowWrap: "anywhere",
  },
  clock: {
    position: "absolute",
    width: 0,
    height: 0,
    opacity: 0,
    animationName: { default: tick, [REDUCED]: "none" },
    animationDuration: appBuilding.beat,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    animationPlayState: v.play,
  },

  // A piece: its place, its move when it changes places, and its fade as the round clears.
  slot: {
    position: "absolute",
    boxSizing: "border-box",
    transitionProperty: "transform, opacity",
    transitionDuration: `${motionVars.ui}, ${motionVars.leave}`,
    transitionTimingFunction: duration.easeInOut,
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
    animationDuration: motionVars.ui,
    animationTimingFunction: duration.ease,
    animationFillMode: "both",
    animationPlayState: v.play,
    animationDelay: PRESS,
    position: "absolute",
    inset: 0,
    boxSizing: "border-box",
    borderRadius: radius.mark,
    transformOrigin: "32% 42%",
  },
  // What is on it: laid out by kind, settling with the surface.
  piece: {
    animationName: { default: settle, [REDUCED]: "none" },
    animationDuration: motionVars.ui,
    animationTimingFunction: duration.ease,
    animationFillMode: "both",
    animationPlayState: v.play,
    position: "absolute",
    inset: 0,
    display: "flex",
    boxSizing: "border-box",
    overflow: "hidden",
    borderRadius: radius.mark,
    transformOrigin: "32% 42%",
    animationDelay: PRESS,
  },
  // Still: no move at all, the finished interface.
  still: { animationName: "none" },

  // The parts inside a piece, laid out by kind.
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space[2],
    paddingInline: "3%",
  },
  side: { flexDirection: "column", gap: space[2], padding: space[3] },
  card: {
    flexDirection: "column",
    justifyContent: "center",
    gap: space[2],
    padding: space[3],
  },
  chart: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: "3%",
    padding: space[3],
  },
  table: {
    flexDirection: "column",
    justifyContent: "space-evenly",
    paddingInline: space[3],
    paddingBlock: space[1],
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space[3],
    minHeight: 0,
  },

  // A line, a dot or a bar inside a piece.
  part: {
    animationName: { default: draw, [REDUCED]: "none" },
    animationDuration: motionVars.ui,
    animationTimingFunction: duration.ease,
    animationFillMode: "both",
    animationPlayState: v.play,
    animationDelay: after(0),
    flexShrink: 0,
    height: space[2],
    borderRadius: radius.full,
    transformOrigin: "0 50%",
  },
  thick: { height: space[4], borderRadius: radius.mark },
  thin: { height: space[1] },
  dot: { width: space[2], borderRadius: radius.circle },
  square: {
    width: space[4],
    height: space[4],
    borderRadius: radius.mark,
  },
  push: { marginInlineStart: "auto" },
  column: {
    animationName: { default: grow, [REDUCED]: "none" },
    animationDuration: motionVars.ui,
    animationTimingFunction: duration.ease,
    animationFillMode: "both",
    animationPlayState: v.play,
    animationDelay: after(0),
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    borderRadius: radius.mark,
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
    transitionDuration: `${motionVars.ui}, ${motionVars.leave}`,
    transitionTimingFunction: duration.easeInOut,
  },
  to: (x: number, y: number) => ({
    transform: `translate(calc(${x}% * ${SIGN}), ${y}%)`,
  }),
  cursor: {
    [iconVars.size]: size.iconDefault,
    [iconVars.stroke]: size.iconStroke,
    position: "absolute",
    top: 0,
    insetInlineStart: 0,
    // The pointer's tip, not its box, stands on the point.
    marginBlockStart: `calc(${size.iconDefault} * -0.14)`,
    marginInlineStart: `calc(${size.iconDefault} * -0.14)`,
  },
  ring: {
    position: "absolute",
    top: 0,
    insetInlineStart: 0,
    width: space[4],
    height: space[4],
    marginBlockStart: `calc(${space[2]} * -0.5)`,
    marginInlineStart: `calc(${space[2]} * -0.5)`,
    borderRadius: radius.circle,
    borderWidth: size.hairline,
    borderStyle: "solid",
    borderColor: "currentColor",
    opacity: 0,
    animationName: { default: ripple, [REDUCED]: "none" },
    animationDuration: motionVars.ui,
    animationDelay: `calc(${PRESS} - ${duration.stagger})`,
    animationTimingFunction: duration.ease,
    animationFillMode: "both",
    animationPlayState: v.play,
  },
  tag: {
    position: "absolute",
    top: `calc(${size.iconDefault} * 0.8)`,
    insetInlineStart: `calc(${size.iconDefault} * 0.6)`,
    paddingInline: space[2],
    borderRadius: radius.full,
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightMedium,
    whiteSpace: "nowrap",
    color: { default: appBuilding.onCursor, [FORCED]: "Canvas" },
  },
  tone0: { color: { default: colors.pine, [FORCED]: "CanvasText" } },
  tone1: { color: { default: colors.mintDeep, [FORCED]: "CanvasText" } },
  tone2: { color: { default: colors.lavender, [FORCED]: "CanvasText" } },
  fill0: { backgroundColor: { default: colors.pine, [FORCED]: "CanvasText" } },
  fill1: {
    backgroundColor: { default: colors.mintDeep, [FORCED]: "CanvasText" },
  },
  fill2: {
    backgroundColor: { default: colors.lavender, [FORCED]: "CanvasText" },
  },
});

// The blocks: the ground, a piece's surface, and the parts inside it, soft blocks with a dither.
export const blocks = stylex.create({
  ground: {
    backgroundColor: { default: colors.background, [FORCED]: "Canvas" },
  },
  piece: {
    backgroundColor: { default: appBuilding.block, [FORCED]: "Canvas" },
    backgroundImage: {
      default: dither(appBuilding.dot),
      [FORCED]: "none",
    },
    backgroundSize: `${appBuilding.dither} ${appBuilding.dither}`,
    outline: {
      default: "none",
      [FORCED]: `${size.hairline} solid CanvasText`,
    },
  },
  part: {
    backgroundColor: {
      default: appBuilding.detail,
      [FORCED]: "GrayText",
    },
  },
  strong: {
    backgroundColor: {
      default: appBuilding.detail,
      [FORCED]: "CanvasText",
    },
  },
});

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
