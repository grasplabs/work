// Progress: how far a task has come, as a bar or a ring, or that it is under way when how far is
// unknown, from shadcn's (registry/bases/base/ui/progress.tsx, on Base UI), converted from Tailwind
// to StyleX and rebuilt on UI SDK's Progress, then made Grasp's on Palermo's Progress Bar: a round
// track in three heights, the first action's colour for what is done, and a ring in three sizes.
//
//   <Progress label="Exporting the report" value={60} />
//   <Progress label="Connecting" value={null} />                    under way, how far unknown
//   <Progress label="Uploading" value={40} shape="ring" size="lg" />
//
// A progress bar is for a task that will finish; a reading such as storage used is a meter. Every
// value is a token (src/tokens).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Progress as ProgressPrimitive,
  ProgressIndicator,
  ProgressLabel,
  ProgressTrack,
  ProgressValue,
} from "@ui-sdk/react/progress";

import { visuallyHidden } from "../hidden/hidden";
import type { LayoutStyle } from "../layout/layout";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { fill } from "./progress.stylex";

export type ProgressSize = "sm" | "md" | "lg";
export type ProgressTone = "neutral" | "success" | "attention" | "danger";

/** What a caller may style: where it sits and how wide it is. */
export type ProgressLayoutStyle = LayoutStyle;

/** Every prop a Progress takes. */
export interface ProgressProps {
  /** What is under way, in a few words ("Exporting the report"). It names the bar. */
  label: string;
  /** How far the task has come, from 0 to `max`. `null` while how far is unknown. */
  value: number | null;
  /**
   * The value at which the task is done.
   * @default 100
   */
  max?: number;
  /**
   * `bar` runs the width it is given, `ring` sits beside words.
   * @default "bar"
   */
  shape?: "bar" | "ring";
  /**
   * A bar 4, 8 or 12px tall; a ring 14, 20 or 60px across. A large ring holds its value.
   * @default "md"
   */
  size?: ProgressSize;
  /**
   * The colour of what is done, when it says something: `success` once it has worked, `attention`
   * when it is slow, `danger` when it stopped.
   * @default "neutral"
   */
  tone?: ProgressTone;
  /**
   * Shows the label and the value above a bar. Hide it where the words beside it already say it;
   * the label still names it. A ring never shows its label.
   * @default true
   */
  showLabel?: boolean;
  /** What a screen reader hears for the value, when the percentage says too little: "3 of 12 files". */
  valueText?: (value: number | null) => string;
  /** Layout only: where it sits and how wide it is. */
  style?: ProgressLayoutStyle;
  /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
  layout?: ProgressLayoutStyle;
}

const REDUCED = media.reduced;
const FORCED = media.forced;
const UNKNOWN = ":is([data-indeterminate])";

// Along the line: --grasp-line-sign is -1 right to left, so the sweep runs from the start there too.
const sweep = stylex.keyframes({
  from: { transform: "translateX(calc(-100% * var(--grasp-line-sign, 1)))" },
  to: { transform: "translateX(calc(300% * var(--grasp-line-sign, 1)))" },
});
const spin = stylex.keyframes({
  from: { transform: "rotate(0turn)" },
  to: { transform: "rotate(1turn)" },
});
// The reduced form: it stays still and breathes.
const breathe = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.4 },
});

// How far unknown, the bar waits as Skeleton's dot field does (skeleton.tsx): fine dots on the
// track, and a soft band of our light, mint into pine, passing along them. Transform only.
// In dark the dots take more of the ink: at 22% they all but vanished on the night ground.
const UNKNOWN_DOTS = `radial-gradient(circle at center, light-dark(color-mix(in oklab, ${grasp.ink} 22%, transparent), color-mix(in oklab, ${grasp.ink} 48%, transparent)) 0.6px, transparent 0.9px)`;
const UNKNOWN_LIT = `radial-gradient(circle at center, ${grasp.ink} 0.9px, transparent 1.3px)`;
const UNKNOWN_BAND = `linear-gradient(90deg, transparent 0%, ${grasp.mint} 40%, ${grasp.pine} 70%, transparent 100%)`;

const styles = stylex.create({
  root: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "baseline",
    columnGap: grasp.space3,
    rowGap: grasp.space2,
    width: "100%",
    minWidth: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  rootRing: {
    display: "inline-grid",
    gridTemplateColumns: "auto",
    width: "auto",
    verticalAlign: "middle",
  },
  neutral: { [fill.colour]: grasp.progressFill },
  success: { [fill.colour]: grasp.success },
  attention: { [fill.colour]: grasp.attention },
  danger: { [fill.colour]: grasp.danger },
  label: {
    minWidth: 0,
    color: grasp.ink,
    fontWeight: grasp.weightMedium,
    overflowWrap: "anywhere",
  },
  value: {
    color: grasp.muted,
    fontVariantNumeric: "tabular-nums",
  },

  // ---- The bar ----
  track: {
    gridColumn: "1 / -1",
    position: "relative",
    overflow: "hidden",
    width: "100%",
    borderRadius: grasp.cornerPill,
    backgroundColor: {
      default: grasp.progressTrack,
      [UNKNOWN]: { default: "transparent", [FORCED]: grasp.progressTrack },
    },
    backgroundImage: {
      default: "none",
      [UNKNOWN]: { default: UNKNOWN_DOTS, [FORCED]: "none" },
    },
    backgroundSize: "3px 3px",
    backgroundPosition: "center",
    // In forced colours the ground is dropped, so a line draws the track.
    outlineWidth: { default: 0, [FORCED]: 1 },
    outlineStyle: "solid",
    outlineOffset: -1,
  },
  sm: { height: grasp.progressSm },
  md: { height: grasp.progressMd },
  lg: { height: grasp.progressLg },
  indicator: {
    "--grasp-line-sign": { default: "1", ":dir(rtl)": "-1" },
    height: "100%",
    borderRadius: "inherit",
    // How far unknown, the light below draws it; only forced colours keep this solid third.
    backgroundColor: {
      default: fill.colour,
      [UNKNOWN]: { default: "transparent", [FORCED]: "CanvasText" },
    },
    forcedColorAdjust: "none",
    transitionProperty: "width",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
    // Under way, how far unknown, in forced colours: a third of the track sweeps across it; with
    // reduced motion it stands still across the whole track.
    width: {
      default: null,
      [UNKNOWN]: { default: "calc(100% / 3)", [REDUCED]: "100%" },
    },
    animationName: {
      default: "none",
      [UNKNOWN]: {
        default: "none",
        [FORCED]: { default: sweep, [REDUCED]: "none" },
      },
    },
    animationDuration: grasp.progressSweep,
    animationTimingFunction: grasp.easeInOut,
    animationIterationCount: "infinite",
  },
  // How far unknown: where the light shows, the track's dots a little larger, standing still while
  // the band moves under them, so the dots light up rather than slide.
  unknownLit: {
    position: "absolute",
    inset: 0,
    display: { default: "block", [FORCED]: "none", [REDUCED]: "none" },
    maskImage: UNKNOWN_LIT,
    maskSize: "3px 3px",
    maskPosition: "center",
  },
  unknownBand: {
    "--grasp-line-sign": { default: "1", ":dir(rtl)": "-1" },
    position: "absolute",
    insetBlock: 0,
    insetInlineStart: 0,
    width: "calc(100% / 3)",
    backgroundImage: UNKNOWN_BAND,
    animationName: { default: sweep, [REDUCED]: "none", [FORCED]: "none" },
    animationDuration: grasp.progressSweep,
    animationTimingFunction: grasp.easeInOut,
    animationIterationCount: "infinite",
  },
  // A tone's light is the tone's own colour, fading in and out.
  unknownBandTone: {
    backgroundImage: `linear-gradient(90deg, transparent 0%, ${fill.colour} 50%, transparent 100%)`,
  },

  // ---- The ring ----
  // A conic fill up to the value, cut to a ring by a mask: no drawing, the value is the angle.
  ring: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    borderRadius: grasp.cornerCircle,
    backgroundImage: {
      default: `conic-gradient(${fill.colour} var(--progress-value, 0%), ${grasp.progressRingTrack} 0)`,
      [UNKNOWN]: `conic-gradient(${fill.colour} 25%, ${grasp.progressRingTrack} 0)`,
      [FORCED]: {
        default:
          "conic-gradient(CanvasText var(--progress-value, 0%), GrayText 0)",
        [UNKNOWN]: "conic-gradient(CanvasText 25%, GrayText 0)",
      },
    },
    forcedColorAdjust: "none",
    animationName: {
      default: "none",
      [UNKNOWN]: { default: spin, [REDUCED]: breathe },
    },
    animationDuration: {
      default: grasp.durationSpin,
      [REDUCED]: grasp.progressSweep,
    },
    animationTimingFunction: { default: "linear", [REDUCED]: grasp.easeInOut },
    animationIterationCount: "infinite",
  },
  ringSm: {
    width: grasp.progressRingSm,
    height: grasp.progressRingSm,
    mask: `radial-gradient(farthest-side, transparent calc(100% - ${grasp.progressRingLine}), #000 calc(100% - ${grasp.progressRingLine} + 0.5px))`,
  },
  ringMd: {
    width: grasp.progressRingMd,
    height: grasp.progressRingMd,
    mask: `radial-gradient(farthest-side, transparent calc(100% - ${grasp.progressRingLine}), #000 calc(100% - ${grasp.progressRingLine} + 0.5px))`,
  },
  ringLg: {
    width: grasp.progressRingLg,
    height: grasp.progressRingLg,
    mask: `radial-gradient(farthest-side, transparent calc(100% - ${grasp.progressRingLineLg}), #000 calc(100% - ${grasp.progressRingLineLg} + 0.5px))`,
  },
  // The large ring's value, in its middle. It stands over the ring, which its mask would cut.
  ringValue: {
    gridArea: "1 / 1",
    placeSelf: "center",
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
    fontVariantNumeric: "tabular-nums",
  },
  ringCell: {
    gridArea: "1 / 1",
  },
});

const tones = {
  neutral: styles.neutral,
  success: styles.success,
  attention: styles.attention,
  danger: styles.danger,
} as const;
const bars = { sm: styles.sm, md: styles.md, lg: styles.lg } as const;
const rings = {
  sm: styles.ringSm,
  md: styles.ringMd,
  lg: styles.ringLg,
} as const;

export const Progress = ({
  label,
  value,
  max = 100,
  shape = "bar",
  size = "md",
  tone = "neutral",
  showLabel = true,
  valueText,
  style,
  layout,
}: ProgressProps) => {
  const placed = layout ?? style;
  const getValueLabel = valueText
    ? (current: number | null) => valueText(current)
    : undefined;
  const root = {
    "data-slot": "progress",
    "data-shape": shape,
    value,
    max,
    getValueLabel,
  } as const;

  if (shape === "ring") {
    return (
      <ProgressPrimitive
        {...root}
        {...stylex.props(styles.root, styles.rootRing, tones[tone], placed)}
      >
        <ProgressLabel {...stylex.props(visuallyHidden)}>{label}</ProgressLabel>
        {/* The track is the ring; the indicator part is kept, unseen, so the value stays wired. */}
        <ProgressTrack
          {...stylex.props(styles.ringCell, styles.ring, rings[size])}
        >
          <ProgressIndicator
            className={stylex.props(visuallyHidden).className}
          />
        </ProgressTrack>
        {size === "lg" && value !== null && (
          <ProgressValue
            aria-hidden="true"
            {...stylex.props(styles.ringValue)}
          />
        )}
      </ProgressPrimitive>
    );
  }

  return (
    <ProgressPrimitive
      {...root}
      {...stylex.props(styles.root, tones[tone], placed)}
    >
      <ProgressLabel
        {...stylex.props(showLabel ? styles.label : visuallyHidden)}
      >
        {label}
      </ProgressLabel>
      {showLabel && value !== null && (
        <ProgressValue aria-hidden="true" {...stylex.props(styles.value)} />
      )}
      <ProgressTrack {...stylex.props(styles.track, bars[size])}>
        {/* The class only: UI SDK sets the indicator's width as its own inline style. */}
        <ProgressIndicator
          className={stylex.props(styles.indicator).className}
        />
        {value === null ? (
          <span aria-hidden="true" {...stylex.props(styles.unknownLit)}>
            <span
              {...stylex.props(
                styles.unknownBand,
                tone !== "neutral" && styles.unknownBandTone
              )}
            />
          </span>
        ) : null}
      </ProgressTrack>
    </ProgressPrimitive>
  );
};
