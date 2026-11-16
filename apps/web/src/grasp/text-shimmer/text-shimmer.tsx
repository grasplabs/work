// TextShimmer: a line that says what an agent is doing ("Thinking", "Reading the contract"), with
// a narrow band of Grasp's light crossing its letters while that work is really running. It says
// "working" without a spinner and lives exactly as long as the work: with `active` off it is plain
// muted words ("Thought for 12 seconds").
//
//   <TextShimmer>Thinking</TextShimmer>
//   <TextShimmer active={false}>Thought for 12 seconds</TextShimmer>
//
// The words are in the page once, muted; over them lies the same words in the light, seen only
// through a soft-edged window that moves across. Only the window's transform is animated (and the
// words inside it the other way, so they stand still), so the sweep stays off the main thread. The
// band is a few characters wide whatever the line's length, and a longer line takes a little
// longer, so short and long lines sweep at the same apparent speed. It rests while off screen.
// Reduced motion: no sweep, the words muted. Forced colours: plain words. Right to left: the band
// runs the other way. A screen reader reads the words once: the light's copy is hidden from it.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";

import { grasp, media } from "../tokens/tokens.stylex";
import { shimmerVars as v } from "./shimmer.stylex";

/** How strong the light is. */
export type TextShimmerStrength = "soft" | "clear" | "bright";

/** What a caller may style: where the line sits. Never its look. */
export type TextShimmerLayoutStyle = stylex.StyleXStyles<{
  margin?: string | number;
  marginBlock?: string | number;
  marginInline?: string | number;
  justifySelf?: string;
  alignSelf?: string;
}>;

/** Every prop a TextShimmer takes. */
export interface TextShimmerProps {
  /** The words. */
  children: string;
  /**
   * The work is running: the light crosses the words. Turn it off the moment the work ends.
   * @default true
   */
  active?: boolean;
  /**
   * How strong the light is: `soft` (pine, a narrow band), `clear` (deep mint on paper, mint on
   * night) or `bright` (stronger still, a wider band).
   * @default "clear"
   */
  strength?: TextShimmerStrength;
  /**
   * The words go on to a next line where there is no room, as any text does, and the light passes
   * over each line. With `wrap={false}` it is one line, cut with an ellipsis (its whole words stay
   * within reach as its title): only where a place has room for one line and no more.
   * @default true
   */
  wrap?: boolean;
  /** Layout only: margins and alignment. */
  layout?: TextShimmerLayoutStyle;
}

// The window is as wide as the line, and its band is in its middle: half a line and half a band
// back, the band is just before the words; as far on, just after them. Then it rests off them.
const reach = `calc((50% + ${v.band} / 2) * var(--shimmer-way))`;
const back = `calc((-50% - ${v.band} / 2) * var(--shimmer-way))`;
const cross = stylex.keyframes({
  "0%": { transform: `translateX(${back})` },
  "80%": { transform: `translateX(${reach})` },
  "100%": { transform: `translateX(${reach})` },
});
// The words inside go the other way by as much, so they stay where the words under them are.
const stay = stylex.keyframes({
  "0%": { transform: `translateX(${reach})` },
  "80%": { transform: `translateX(${back})` },
  "100%": { transform: `translateX(${back})` },
});

const styles = stylex.create({
  line: {
    position: "relative",
    display: "inline-block",
    maxWidth: "100%",
    overflow: "clip",
    color: { default: grasp.muted, [media.forced]: "CanvasText" },
    fontVariantNumeric: "tabular-nums",
    "--shimmer-way": { default: "1", ":dir(rtl)": "-1" },
  },
  // New words take the old ones' place in one frame, never passing through empty: a fade from
  // nothing made a line that changes step by step blink between its words (B-working-mark-02).
  // As wide as the line and no wider: words too long for their room are cut here, with an ellipsis.
  words: {
    display: "block",
    overflow: "clip",
    textOverflow: "ellipsis",
  },
  window: {
    position: "absolute",
    inset: 0,
    display: {
      default: "block",
      [media.reduced]: "none",
      [media.forced]: "none",
    },
    overflow: "clip",
    pointerEvents: "none",
    // The light's copy of the words is never selected or copied with them.
    userSelect: "none",
    // A soft-edged band in the middle of the window: no line where the light starts.
    maskImage:
      "linear-gradient(90deg, transparent 0%, color-mix(in srgb, black 15%, transparent) 20%, black 50%, color-mix(in srgb, black 15%, transparent) 80%, transparent 100%)",
    maskSize: `${v.band} 100%`,
    maskRepeat: "no-repeat",
    maskPosition: "center",
    // No sweep with reduced motion or in forced colours: no animation at all, not a hidden one.
    animationName: {
      default: cross,
      [media.reduced]: "none",
      [media.forced]: "none",
    },
    animationDuration: v.pass,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    animationPlayState: v.play,
    willChange: "transform",
  },
  lit: {
    display: "block",
    // Cut where the words under it are cut.
    overflow: "clip",
    textOverflow: "ellipsis",
    animationName: {
      default: stay,
      [media.reduced]: "none",
      [media.forced]: "none",
    },
    animationDuration: v.pass,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    animationPlayState: v.play,
    willChange: "transform",
  },
  soft: { color: grasp.textShimmerSoft },
  clear: { color: grasp.textShimmerClear },
  bright: { color: grasp.textShimmerBright },
  paused: { [v.play]: "paused" },
  // One line and no more: cut with an ellipsis.
  oneLine: { whiteSpace: "nowrap" },
});

const sizes = stylex.create({
  of: (band: string, pass: string) => ({ [v.band]: band, [v.pass]: pass }),
});

const bands = { soft: 4, clear: 5, bright: 8 } as const;

/** One pass for words of this length: 1.6s for a short line, up to 2.2s for a long one, and a rest. */
const passOf = (length: number) =>
  `${Math.round((1600 + Math.min(Math.max(length - 8, 0), 30) * 20) / 0.8)}ms`;

/** Whether the line is on screen: the light rests while it is not. */
const useSeen = () => {
  const line = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(true);
  useEffect(() => {
    const element = line.current;
    const watcher = new IntersectionObserver((entries) => {
      setSeen(entries.at(-1)?.isIntersecting ?? true);
    });
    if (element !== null) {
      watcher.observe(element);
    }
    return () => {
      watcher.disconnect();
    };
  }, []);
  return { line, seen };
};

/** A line of what an agent is doing, the light crossing it while the work runs. */
export const TextShimmer = ({
  children,
  active = true,
  strength = "clear",
  wrap = true,
  layout,
}: TextShimmerProps) => {
  const { line, seen } = useSeen();
  return (
    <span
      ref={line}
      data-slot="text-shimmer"
      data-active={active || undefined}
      // A line that may be cut short keeps its whole words within reach.
      title={wrap ? undefined : children}
      {...stylex.props(
        styles.line,
        sizes.of(`${bands[strength]}ch`, passOf(children.length)),
        !seen && styles.paused,
        !wrap && styles.oneLine,
        layout
      )}
    >
      <span {...stylex.props(styles.words)}>{children}</span>
      {active && (
        <span aria-hidden="true" {...stylex.props(styles.window)}>
          <span {...stylex.props(styles.lit, styles[strength])}>
            {children}
          </span>
        </span>
      )}
    </span>
  );
};
