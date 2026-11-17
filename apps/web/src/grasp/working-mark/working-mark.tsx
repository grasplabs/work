// WorkingMark: Grasp's sign that an agent is working, in an icon's room. The dither glyph by
// default: nine dots of pine, three by three, and the light passing through them in a wave, its
// core in mint. The same language as the loading dot field and the Composer's dithered edge, so
// "working" and "loading" read as one family (docs/patterns/working-mark.mdx compares the others).
//
//   <WorkingMark />                          beside words that say what is working
//   <WorkingMark label="Searching the web" /> alone: a status that says its label
//   <WorkingMark done />                     the work ended: a tick drawn in where it stood
//
// It runs only while it is shown and on screen (it pauses off screen and in a hidden tab), moves
// only transform and opacity, and stands still with reduced motion, one line of it lit. Never show
// two in one view. Every value is a token (src/tokens). A caller may set layout only (`style`).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";

import { visuallyHidden } from "../hidden/hidden";
import { Icon, Tick } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";
import { markVars as v } from "./working-mark.stylex";

/** How the mark moves: the dither glyph (Grasp's), or one of the three it was chosen from. @deprecated Use `AgentIndicatorVariant`, from `@/components/grasp/agent-indicator`. */
export type WorkingMarkVariant = "dither" | "orbit" | "breath" | "bead";

/** The dither glyph's path: a diagonal wave, round its edge, or row by row. @deprecated Use `AgentIndicatorPath`, from `@/components/grasp/agent-indicator`. */
export type WorkingMarkPath = "wave" | "circle" | "snake";

/**
 * The mark every part shows while it works. The one place the choice is written: change it here
 * and Agent activity, the Composer and Chat message follow.
 * @deprecated Use `agentIndicatorVariant`, from `@/components/grasp/agent-indicator`.
 */
export const workingMarkVariant: WorkingMarkVariant = "dither";

/** What a caller may style: where the mark sits. Never its look. @deprecated Use `AgentIndicatorLayoutStyle`, from `@/components/grasp/agent-indicator`. */
export type WorkingMarkLayoutStyle = LayoutStyle;

/** Every prop a WorkingMark takes. @deprecated Use `AgentIndicatorProps`, from `@/components/grasp/agent-indicator`. */
export interface WorkingMarkProps {
  /**
   * How it moves. Leave it out for Grasp's choice (`workingMarkVariant`).
   * @default "dither"
   */
  variant?: WorkingMarkVariant;
  /**
   * The dither glyph's path.
   * @default "wave"
   */
  path?: WorkingMarkPath;
  /**
   * The work ended: a tick is drawn in where the mark stood. Leave the mark out instead where the
   * place has a done mark of its own (a step's icon).
   * @default false
   */
  done?: boolean;
  /**
   * What is working, said once to a screen reader, never shown. Give it when no words beside it
   * say so; leave it out when they do, and make those words the status.
   */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /** @deprecated Use `layout`. */
  style?: WorkingMarkLayoutStyle;
  /** Layout only: margins and alignment. The look belongs to the mark. */
  layout?: WorkingMarkLayoutStyle;
}

const REDUCED = media.reduced;
const FORCED = media.forced;

// A dot of the dither glyph as the light passes: it comes up, a little larger, and falls back.
const glint = stylex.keyframes({
  "0%": { opacity: 0, transform: "scale(0.6)" },
  "20%": { opacity: 1, transform: "scale(1.2)" },
  "55%": { opacity: 0, transform: "scale(0.6)" },
  "100%": { opacity: 0, transform: "scale(0.6)" },
});
// The orbit's arc once round, then a rest. Right to left it turns the other way.
const turn = stylex.keyframes({
  "0%": { transform: "rotate(0turn)" },
  "68%": { transform: "rotate(calc(1turn * var(--grasp-mark-sign, 1)))" },
  "100%": { transform: "rotate(calc(1turn * var(--grasp-mark-sign, 1)))" },
});
// The breath's ring growing and falling back (it runs alternate).
const breathe = stylex.keyframes({
  from: { transform: "scale(0.68)", opacity: 0.45 },
  to: { transform: "scale(1)", opacity: 1 },
});
// The glint crossing the bead, then a rest.
const glide = stylex.keyframes({
  "0%": { transform: "translateX(calc(-100% * var(--grasp-mark-sign, 1)))" },
  "55%": { transform: "translateX(calc(100% * var(--grasp-mark-sign, 1)))" },
  "100%": { transform: "translateX(calc(100% * var(--grasp-mark-sign, 1)))" },
});
// Done: a tick drawn in from the start of the line.
const draw = stylex.keyframes({
  from: { clipPath: "inset(0 100% 0 0)" },
  to: { clipPath: "inset(0 0 0 0)" },
});
const drawBack = stylex.keyframes({
  from: { clipPath: "inset(0 0 0 100%)" },
  to: { clipPath: "inset(0 0 0 0)" },
});

const lit = { default: grasp.workingMarkLit, [FORCED]: "CanvasText" };
const accent = { default: grasp.workingMarkAccent, [FORCED]: "CanvasText" };
const rest = { default: grasp.workingMarkRest, [FORCED]: "GrayText" };
// Two dots and a gap, as the glyph's third: the room an orbit or a breath fills.
const body = `calc(${grasp.workingMarkDot} * 3 + ${grasp.workingMarkGap} * 2)`;

const styles = stylex.create({
  // The room it stands in: an icon's, so it sits where a step's icon sits and nothing shifts.
  mark: {
    "--grasp-mark-sign": { default: "1", ":dir(rtl)": "-1" },
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    verticalAlign: "middle",
    width: grasp.iconSm,
    height: grasp.iconSm,
    // Its colours are set for forced colours below, so they are kept as set.
    forcedColorAdjust: "none",
  },
  paused: { [v.play]: "paused" },

  // The dither glyph.
  grid: {
    display: "grid",
    gridTemplateColumns: `repeat(3, ${grasp.workingMarkDot})`,
    gap: grasp.workingMarkGap,
  },
  dot: {
    position: "relative",
    width: grasp.workingMarkDot,
    height: grasp.workingMarkDot,
    borderRadius: grasp.cornerCircle,
    backgroundColor: rest,
  },
  lit: {
    position: "absolute",
    inset: 0,
    borderRadius: grasp.cornerCircle,
    backgroundColor: lit,
    opacity: 0,
    animationName: { default: glint, [REDUCED]: "none" },
    animationDuration: v.loop,
    animationTimingFunction: grasp.easeInOut,
    animationIterationCount: "infinite",
    animationFillMode: "backwards",
    animationPlayState: v.play,
  },
  core: { backgroundColor: accent },
  // Still: one line of the path stays lit, so it is still a mark.
  still: { opacity: { default: 0, [REDUCED]: 1 } },
  wave: {
    [v.loop]: grasp.workingMarkWave,
    [v.step]: grasp.workingMarkWaveStep,
  },
  circle: {
    [v.loop]: grasp.workingMarkCircle,
    [v.step]: grasp.workingMarkCircleStep,
  },
  snake: {
    [v.loop]: grasp.workingMarkSnake,
    [v.step]: grasp.workingMarkSnakeStep,
  },
  at0: { animationDelay: "0ms" },
  at1: { animationDelay: v.step },
  at2: { animationDelay: `calc(${v.step} * 2)` },
  at3: { animationDelay: `calc(${v.step} * 3)` },
  at4: { animationDelay: `calc(${v.step} * 4)` },
  at5: { animationDelay: `calc(${v.step} * 5)` },
  at6: { animationDelay: `calc(${v.step} * 6)` },
  at7: { animationDelay: `calc(${v.step} * 7)` },
  at8: { animationDelay: `calc(${v.step} * 8)` },

  // The orbit: one arc once round a still point, then a rest.
  point: {
    width: grasp.workingMarkCore,
    height: grasp.workingMarkCore,
    borderRadius: grasp.cornerCircle,
    backgroundColor: accent,
  },
  arc: {
    position: "absolute",
    width: body,
    height: body,
    borderRadius: grasp.cornerCircle,
    backgroundImage: {
      default: `conic-gradient(from 0turn, transparent 0turn, transparent 0.62turn, ${grasp.workingMarkLit} 1turn)`,
      [FORCED]:
        "conic-gradient(from 0turn, transparent 0turn, transparent 0.62turn, CanvasText 1turn)",
    },
    maskImage: `radial-gradient(closest-side, transparent calc(100% - ${grasp.workingMarkStroke}), black calc(100% - ${grasp.workingMarkStroke} + 0.5px))`,
    animationName: { default: turn, [REDUCED]: "none" },
    animationDuration: grasp.workingMarkOrbit,
    animationTimingFunction: grasp.easeInOut,
    animationIterationCount: "infinite",
    animationPlayState: v.play,
  },

  // The breath: one ring growing and falling back round a still core.
  ring: {
    position: "absolute",
    boxSizing: "border-box",
    width: body,
    height: body,
    borderRadius: grasp.cornerCircle,
    borderWidth: grasp.workingMarkStroke,
    borderStyle: "solid",
    borderColor: lit,
    animationName: { default: breathe, [REDUCED]: "none" },
    animationDuration: grasp.workingMarkBreath,
    animationTimingFunction: grasp.easeInOut,
    animationIterationCount: "infinite",
    animationDirection: "alternate",
    animationPlayState: v.play,
  },

  // The bead: pine, a glint crossing it, mint only as its core.
  bead: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: body,
    height: body,
    overflow: "hidden",
    borderRadius: grasp.cornerCircle,
    backgroundColor: lit,
  },
  glint: {
    position: "absolute",
    inset: 0,
    display: { default: "block", [REDUCED]: "none", [FORCED]: "none" },
    backgroundImage: `linear-gradient(105deg, transparent 20%, color-mix(in oklch, ${grasp.lightPaper} 70%, transparent) 50%, transparent 80%)`,
    animationName: glide,
    animationDuration: grasp.workingMarkGlide,
    animationTimingFunction: grasp.easeInOut,
    animationIterationCount: "infinite",
    animationPlayState: v.play,
  },
  beadCore: { backgroundColor: { default: grasp.mint, [FORCED]: "Canvas" } },

  // Done: a tick drawn in where the mark stood.
  tick: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "inline-flex",
    color: accent,
    animationName: { default: draw, ":dir(rtl)": drawBack, [REDUCED]: "none" },
    animationDuration: grasp.durationMark,
    animationTimingFunction: grasp.ease,
    animationFillMode: "backwards",
  },
});

// The order the light reaches each of the nine dots, per path (-1: a dot it never reaches), and
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

/** The cleanup of an effect that started nothing. */
const keep = () => {
  // Nothing was started, so nothing stops.
};

/** Whether the element is on screen, in a tab that is shown: the mark stops when nobody can see it. */
const useSeen = () => {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [seen, setSeen] = useState(true);
  useEffect(() => {
    const element = ref.current;
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
  }, []);
  return { ref, seen };
};

const Dither = ({ path }: { path: WorkingMarkPath }) => {
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
  variant: WorkingMarkVariant;
  path: WorkingMarkPath;
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

/** Grasp's sign that an agent is working, in an icon's room; a tick drawn in once it is `done`. @deprecated Use `AgentIndicator`, from `@/components/grasp/agent-indicator`. */
export const WorkingMark = ({
  variant = workingMarkVariant,
  path = "wave",
  done = false,
  label: labelDeprecated,
  "aria-label": label = labelDeprecated,
  style,
  layout,
}: WorkingMarkProps) => {
  const { ref, seen } = useSeen();
  // The caller's layout goes on the root: the mark alone, or the status round it when named.
  const named = label !== undefined && label !== "";
  const place = layout ?? style;
  const mark = (
    <span
      ref={ref}
      aria-hidden="true"
      data-slot="working-mark"
      data-variant={variant}
      {...stylex.props(styles.mark, !seen && styles.paused, !named && place)}
    >
      {done ? (
        <span data-slot="working-mark-done" {...stylex.props(styles.tick)}>
          <Icon icon={Tick} />
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
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not every screen reader treats <output> as a live region; role="status" is
    <span role="status" {...stylex.props(place)}>
      {mark}
      <span {...stylex.props(visuallyHidden)}>{label}</span>
    </span>
  );
};
