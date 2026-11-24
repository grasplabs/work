// Agent indicator: a small moving mark that shows work in progress, in an icon's room. The dither
// glyph by default: nine square pixels, three by three, and the light passing through them in a
// wave, its core in the accent. A tick is drawn in where it stood once the work succeeds.
//
//   <AgentIndicator />                                beside words that say what is working
//   <AgentIndicator aria-label="Searching the web" /> alone: a status that says its name
//   <AgentIndicator success />                        the work ended: a tick drawn in
//
// It runs only while it is shown and on screen (it pauses off screen and in a hidden tab), moves
// only transform and opacity, and stands still with reduced motion, one line of it lit. Never show
// two in one view. Every value is a token. A caller may set layout only (`style`).
"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { CheckIcon, Icon } from "../lib/icons";
import { visuallyHidden } from "../lib/styles";
import { colors, duration, media, radius, size } from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";
import { iconVars } from "../lib/vars.stylex";

/** How the mark moves: the dither glyph, or one of the three it was chosen from. */
export type AgentIndicatorVariant = "dither" | "orbit" | "breath" | "bead";

/** The dither glyph's path: a diagonal wave, round its edge, or row by row. */
export type AgentIndicatorPath = "wave" | "circle" | "snake";

/** Every prop an AgentIndicator takes. */
export interface AgentIndicatorProps {
  /**
   * How it moves.
   * @default "dither"
   */
  variant?: AgentIndicatorVariant;
  /**
   * The dither glyph's path.
   * @default "wave"
   */
  path?: AgentIndicatorPath;
  /**
   * The work ended: a tick is drawn in where the mark stood. Leave the mark out instead where the
   * place has a mark of its own for it (a step's icon).
   * @default false
   */
  success?: boolean;
  /**
   * What is working, said once to a screen reader, never shown. Give it when no words beside it
   * say so; leave it out when they do, and make those words the status.
   */
  "aria-label"?: string;
  /** Layout only: margins and alignment. The look belongs to the mark. */
  style?: LayoutStyle;
}

const REDUCED = media.reducedMotion;
const FORCED = media.forcedColors;

// What the parts read from the mark round them: whether it plays, which way the reading runs, and
// the dither path's loop and step.
const PLAY = "--agent-indicator-play";
const SIGN = "--agent-indicator-sign";
const LOOP = "--agent-indicator-loop";
const STEP = "--agent-indicator-step";
const play = `var(${PLAY}, running)`;
const loop = `var(${LOOP})`;
const step = `var(${STEP})`;

// A pixel of the dither glyph as the light passes: it comes up, a little larger, and falls back.
const glint = stylex.keyframes({
  "0%": { opacity: 0, transform: "scale(0.6)" },
  "20%": { opacity: 1, transform: "scale(1.2)" },
  "55%": { opacity: 0, transform: "scale(0.6)" },
  "100%": { opacity: 0, transform: "scale(0.6)" },
});
// The orbit's arc once round, then a rest. Right to left it turns the other way.
const turn = stylex.keyframes({
  "0%": { transform: "rotate(0turn)" },
  "68%": { transform: `rotate(calc(1turn * var(${SIGN}, 1)))` },
  "100%": { transform: `rotate(calc(1turn * var(${SIGN}, 1)))` },
});
// The breath's ring growing and falling back (it runs alternate).
const breathe = stylex.keyframes({
  from: { transform: "scale(0.68)", opacity: 0.45 },
  to: { transform: "scale(1)", opacity: 1 },
});
// The glint crossing the bead, then a rest.
const glide = stylex.keyframes({
  "0%": { transform: `translateX(calc(-100% * var(${SIGN}, 1)))` },
  "55%": { transform: `translateX(calc(100% * var(${SIGN}, 1)))` },
  "100%": { transform: `translateX(calc(100% * var(${SIGN}, 1)))` },
});
// Success: a tick drawn in from the start of the line.
const draw = stylex.keyframes({
  from: { clipPath: "inset(0 100% 0 0)" },
  to: { clipPath: "inset(0 0 0 0)" },
});
const drawBack = stylex.keyframes({
  from: { clipPath: "inset(0 0 0 100%)" },
  to: { clipPath: "inset(0 0 0 0)" },
});

const lit = { default: colors.agentIndicatorLit, [FORCED]: "CanvasText" };
const accent = { default: colors.agentIndicatorAccent, [FORCED]: "CanvasText" };
const rest = { default: colors.agentIndicatorRest, [FORCED]: "GrayText" };
// Two pixels and a gap, as the glyph's third: the room an orbit or a breath fills.
const body = `calc(${size.agentIndicatorDot} * 3 + ${size.agentIndicatorGap} * 2)`;

const styles = stylex.create({
  // The room it stands in: an icon's, so it sits where a step's icon sits and nothing shifts.
  mark: {
    [SIGN]: { default: "1", ":dir(rtl)": "-1" },
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    verticalAlign: "middle",
    width: size.iconSm,
    height: size.iconSm,
    // Its colours are set for forced colours below, so they are kept as set.
    forcedColorAdjust: "none",
  },
  paused: { [PLAY]: "paused" },

  // The dither glyph: pixels, so its cells are square, never dots.
  grid: {
    display: "grid",
    gridTemplateColumns: `repeat(3, ${size.agentIndicatorDot})`,
    gap: size.agentIndicatorGap,
  },
  dot: {
    position: "relative",
    width: size.agentIndicatorDot,
    height: size.agentIndicatorDot,
    backgroundColor: rest,
  },
  lit: {
    position: "absolute",
    inset: 0,
    backgroundColor: lit,
    opacity: 0,
    animationName: { default: glint, [REDUCED]: "none" },
    animationDuration: loop,
    animationTimingFunction: duration.easeInOut,
    animationIterationCount: "infinite",
    animationFillMode: "backwards",
    animationPlayState: play,
  },
  core: { backgroundColor: accent },
  // Still: one line of the path stays lit, so it is still a mark.
  still: { opacity: { default: 0, [REDUCED]: 1 } },
  wave: {
    [LOOP]: duration.agentIndicatorWave,
    [STEP]: duration.agentIndicatorWaveStep,
  },
  circle: {
    [LOOP]: duration.agentIndicatorCircle,
    [STEP]: duration.agentIndicatorCircleStep,
  },
  snake: {
    [LOOP]: duration.agentIndicatorSnake,
    [STEP]: duration.agentIndicatorSnakeStep,
  },
  at0: { animationDelay: "0ms" },
  at1: { animationDelay: step },
  at2: { animationDelay: `calc(${step} * 2)` },
  at3: { animationDelay: `calc(${step} * 3)` },
  at4: { animationDelay: `calc(${step} * 4)` },
  at5: { animationDelay: `calc(${step} * 5)` },
  at6: { animationDelay: `calc(${step} * 6)` },
  at7: { animationDelay: `calc(${step} * 7)` },
  at8: { animationDelay: `calc(${step} * 8)` },

  // The orbit: one arc once round a still point, then a rest.
  point: {
    width: size.agentIndicatorCore,
    height: size.agentIndicatorCore,
    borderRadius: radius.circle,
    backgroundColor: accent,
  },
  arc: {
    position: "absolute",
    width: body,
    height: body,
    borderRadius: radius.circle,
    backgroundImage: {
      default: `conic-gradient(from 0turn, transparent 0turn, transparent 0.62turn, ${colors.agentIndicatorLit} 1turn)`,
      [FORCED]:
        "conic-gradient(from 0turn, transparent 0turn, transparent 0.62turn, CanvasText 1turn)",
    },
    maskImage: `radial-gradient(closest-side, transparent calc(100% - ${size.agentIndicatorStroke}), black calc(100% - ${size.agentIndicatorStroke} + 0.5px))`,
    animationName: { default: turn, [REDUCED]: "none" },
    animationDuration: duration.agentIndicatorOrbit,
    animationTimingFunction: duration.easeInOut,
    animationIterationCount: "infinite",
    animationPlayState: play,
  },

  // The breath: one ring growing and falling back round a still core.
  ring: {
    position: "absolute",
    boxSizing: "border-box",
    width: body,
    height: body,
    borderRadius: radius.circle,
    borderWidth: size.agentIndicatorStroke,
    borderStyle: "solid",
    borderColor: lit,
    animationName: { default: breathe, [REDUCED]: "none" },
    animationDuration: duration.agentIndicatorBreath,
    animationTimingFunction: duration.easeInOut,
    animationIterationCount: "infinite",
    animationDirection: "alternate",
    animationPlayState: play,
  },

  // The bead: the lit colour, a glint crossing it, the brand's mint only as its core.
  bead: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: body,
    height: body,
    overflow: "hidden",
    borderRadius: radius.circle,
    backgroundColor: lit,
  },
  glint: {
    position: "absolute",
    inset: 0,
    display: { default: "block", [REDUCED]: "none", [FORCED]: "none" },
    backgroundImage: `linear-gradient(105deg, transparent 20%, color-mix(in oklch, ${colors.brandPaper} 70%, transparent) 50%, transparent 80%)`,
    animationName: glide,
    animationDuration: duration.agentIndicatorGlide,
    animationTimingFunction: duration.easeInOut,
    animationIterationCount: "infinite",
    animationPlayState: play,
  },
  beadCore: { backgroundColor: { default: colors.mint, [FORCED]: "Canvas" } },

  // Success: a tick drawn in where the mark stood.
  tick: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "inline-flex",
    color: accent,
    animationName: { default: draw, ":dir(rtl)": drawBack, [REDUCED]: "none" },
    animationDuration: duration.mark,
    animationTimingFunction: duration.ease,
    animationFillMode: "backwards",
  },
});

// The order the light reaches each of the nine pixels, per path (-1: one it never reaches), and
// which step of it stays lit with reduced motion.
const paths = {
  wave: { order: [0, 1, 2, 1, 2, 3, 2, 3, 4], still: 2, style: styles.wave },
  circle: {
    order: [0, 1, 2, 7, -1, 3, 6, 5, 4],
    still: 0,
    style: styles.circle,
  },
  snake: { order: [0, 1, 2, 5, 4, 3, 6, 7, 8], still: 4, style: styles.snake },
} as const;
const delays = [
  styles.at0,
  styles.at1,
  styles.at2,
  styles.at3,
  styles.at4,
  styles.at5,
  styles.at6,
  styles.at7,
  styles.at8,
];
const MIDDLE = 4;

/** The cleanup of a watch that started nothing. */
const keep = () => {
  // Nothing was started, so nothing stops.
};

/**
 * Whether the element is on screen, in a tab that is shown: the mark stops when nobody can see it.
 * The watch goes with the element, through its ref: named, the mark moves into the status, a new
 * element that is watched afresh.
 */
const useSeen = () => {
  const [seen, setSeen] = useState(true);
  const ref = (element: HTMLSpanElement | null) => {
    if (element === null || typeof IntersectionObserver === "undefined") {
      return keep;
    }
    let inView = true;
    const update = () => {
      setSeen(inView && document.visibilityState === "visible");
    };
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? true;
      update();
    });
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  };
  return { ref, seen };
};

const Dither = ({ path }: { path: AgentIndicatorPath }) => {
  const { order, still, style } = paths[path];
  return (
    <span {...stylex.props(styles.grid, style)}>
      {order.map((at, index) => (
        <span key={index} {...stylex.props(styles.dot)}>
          {at >= 0 && (
            <span
              {...stylex.props(
                styles.lit,
                delays[at],
                index === MIDDLE && styles.core,
                at === still && styles.still
              )}
            />
          )}
        </span>
      ))}
    </span>
  );
};

const Body = ({
  variant,
  path,
}: {
  variant: AgentIndicatorVariant;
  path: AgentIndicatorPath;
}) => {
  if (variant === "orbit") {
    return (
      <>
        <span {...stylex.props(styles.arc)} />
        <span {...stylex.props(styles.point)} />
      </>
    );
  }
  if (variant === "breath") {
    return (
      <>
        <span {...stylex.props(styles.ring)} />
        <span {...stylex.props(styles.point)} />
      </>
    );
  }
  if (variant === "bead") {
    return (
      <span {...stylex.props(styles.bead)}>
        <span {...stylex.props(styles.glint)} />
        <span {...stylex.props(styles.point, styles.beadCore)} />
      </span>
    );
  }
  return <Dither path={path} />;
};

/** A small moving mark that shows work in progress, in an icon's room; a tick once it succeeds. */
export const AgentIndicator = ({
  variant = "dither",
  path = "wave",
  success = false,
  "aria-label": label,
  style,
}: AgentIndicatorProps) => {
  const { ref, seen } = useSeen();
  // The caller's layout goes on the root: the mark alone, or the status round it when named.
  const named = label !== undefined && label !== "";
  const mark = (
    <span
      ref={ref}
      aria-hidden="true"
      data-slot="agent-indicator"
      data-variant={variant}
      {...stylex.props(styles.mark, !seen && styles.paused, !named && style)}
    >
      {success ? (
        <span
          data-slot="agent-indicator-success"
          {...stylex.props(styles.tick)}
        >
          <Icon icon={CheckIcon} />
        </span>
      ) : (
        <Body variant={variant} path={path} />
      )}
    </span>
  );
  if (!named) {
    return mark;
  }
  // A live region reads its text, not a name: the label is hidden text inside the status.
  return (
    <span role="status" {...stylex.props(style)}>
      {mark}
      <span {...stylex.props(visuallyHidden)}>{label}</span>
    </span>
  );
};
