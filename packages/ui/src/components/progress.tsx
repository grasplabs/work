// Progress: how far a task has come, as a bar (Progress) or a ring (ProgressCircle), or that it is
// under way when how far is unknown, in StyleX,
// built on UI SDK's Progress: a round track in three
// heights, the primary colour for what is done, and a ring in three sizes.
//
//   <Progress value={60}>
//     <ProgressLabel>Exporting the report</ProgressLabel>
//     <ProgressValue />
//   </Progress>
//   <Progress aria-label="Connecting" value={null} />             no words above it; how far unknown
//   <ProgressCircle aria-label="Uploading" value={40} size="lg" />
//
// A progress bar is for a task that will finish; a reading such as storage used is a meter.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Progress as ProgressPrimitive,
  ProgressIndicator,
  ProgressLabel as ProgressLabelPrimitive,
  ProgressTrack,
  ProgressValue as ProgressValuePrimitive,
} from "@ui-sdk/react/progress";
import { createContext, use } from "react";
import type { ReactNode } from "react";

import { visuallyHidden } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "../lib/tokens.stylex";
import { className } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { motionVars, pixel, pixelVars } from "../lib/vars.stylex";
import { progressVars } from "./progress.stylex";

export type ProgressSize = "sm" | "default" | "lg";
export type ProgressVariant = "default" | "success" | "warning" | "destructive";

/** Every prop a Progress takes. */
export interface ProgressProps {
  /** How far the task has come, from 0 to `max`. `null` while how far is unknown. */
  value: number | null;
  /**
   * The value at which the task is done.
   * @default 100
   */
  max?: number;
  /**
   * What stands above the bar: a ProgressLabel, which names it, and a ProgressValue at the line's
   * end. Left out where the words beside it already say it; `aria-label` names it then.
   */
  children?: ReactNode;
  /** What is under way, in a few words ("Exporting the report"), when no ProgressLabel names the bar. */
  "aria-label"?: string;
  /**
   * The colour of what is done, when it says something: `success` once it has worked, `warning`
   * when it is slow, `destructive` when it stopped.
   * @default "default"
   */
  variant?: ProgressVariant;
  /**
   * The bar 4, 8 or 12px tall.
   * @default "default"
   */
  size?: ProgressSize;
  /** What a screen reader hears for the value, when the percentage says too little: "3 of 12 files". */
  getAriaValueText?: (value: number | null) => string;
  /** Layout only: where it sits and how wide it is. */
  style?: LayoutStyle;
}

/** Every prop a ProgressLabel takes. */
export interface ProgressLabelProps {
  /** What is under way, in a few words ("Exporting the report"). It names the bar. */
  children: ReactNode;
}

/** Every prop a ProgressValue takes. */
export interface ProgressValueProps {
  /**
   * What it shows, from the formatted value ("40%") and the value itself. Left out, the formatted
   * value.
   */
  children?: (formatted: string, value: number | null) => ReactNode;
}

/** Every prop a ProgressCircle takes: a Progress's, drawn as a ring. */
export interface ProgressCircleProps {
  /** How far the task has come, from 0 to `max`. `null` while how far is unknown: the ring turns. */
  value: number | null;
  /**
   * The value at which the task is done.
   * @default 100
   */
  max?: number;
  /** What is under way, in a few words ("Uploading"). It names the ring, which shows no words. */
  "aria-label"?: string;
  /**
   * Shows the value in the middle of a large ring.
   * @default true
   */
  showValue?: boolean;
  /**
   * The colour of what is done: `success`, `warning` or `destructive` when it says something.
   * @default "default"
   */
  variant?: ProgressVariant;
  /**
   * The ring 14, 20 or 60px across. A large ring holds its value.
   * @default "default"
   */
  size?: ProgressSize;
  /** What a screen reader hears for the value, when the percentage says too little: "3 of 12 files". */
  getAriaValueText?: (value: number | null) => string;
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

const REDUCED = media.reducedMotion;
const FORCED = media.forcedColors;
const UNKNOWN = ":is([data-indeterminate])";

// Along the line: --progress-line-sign is -1 right to left, so the sweep runs from the start there too.
const sweep = stylex.keyframes({
  from: {
    transform: "translateX(calc(-100% * var(--progress-line-sign, 1)))",
  },
  to: { transform: "translateX(calc(300% * var(--progress-line-sign, 1)))" },
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

// How far unknown, the bar waits as Skeleton's wave does: fine pixels on the track (lib's
// fine pixel, in every 3px), and a soft band of light, mint into pine, passing along them.
// Transform only. In dark the pixels take more of the foreground: at 22% they all but vanished on
// the night ground.
const UNKNOWN_PIXEL = `light-dark(color-mix(in oklab, ${colors.foreground} 22%, transparent), color-mix(in oklab, ${colors.foreground} 48%, transparent))`;
const UNKNOWN_PITCH = "3px 3px";
/**
 * Where the grid starts, along each side: a pixel stands in the track's middle, as the dots it is
 * drawn for did (their 3px tiles were centred), on a whole pixel. Centring the tiles themselves puts
 * a track of an even height on half pixels, a smear. Where a browser lacks the maths the grid starts
 * at the corner.
 */
const MIDDLE = `round(down, calc(50% + 1.5px - ${pixelVars.fine} / 2), 1px)`;
const UNKNOWN_START = `${MIDDLE} ${MIDDLE}`;
const UNKNOWN_BAND = `linear-gradient(90deg, transparent 0%, ${colors.mint} 40%, ${colors.pine} 70%, transparent 100%)`;

const styles = stylex.create({
  root: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "baseline",
    columnGap: space["3"],
    rowGap: space["2"],
    width: "100%",
    minWidth: 0,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  rootCircle: {
    display: "inline-grid",
    gridTemplateColumns: "auto",
    width: "auto",
    verticalAlign: "middle",
  },
  default: { [progressVars.color]: colors.progressBg },
  success: { [progressVars.color]: colors.success },
  warning: { [progressVars.color]: colors.warning },
  destructive: { [progressVars.color]: colors.destructive },
  label: {
    minWidth: 0,
    color: colors.foreground,
    fontWeight: font.weightMedium,
    overflowWrap: "anywhere",
  },
  value: {
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
  },

  // ---- The bar ----
  track: {
    gridColumn: "1 / -1",
    position: "relative",
    overflow: "hidden",
    width: "100%",
    borderRadius: radius.full,
    backgroundColor: {
      default: colors.progressTrack,
      [UNKNOWN]: { default: "transparent", [FORCED]: colors.progressTrack },
    },
    [pixelVars.color]: UNKNOWN_PIXEL,
    backgroundImage: {
      default: "none",
      [UNKNOWN]: { default: pixel.fineFill, [FORCED]: "none" },
    },
    backgroundSize: UNKNOWN_PITCH,
    backgroundPosition: UNKNOWN_START,
    // In forced colours the ground is dropped, so a line draws the track.
    outlineWidth: { default: 0, [FORCED]: 1 },
    outlineStyle: "solid",
    outlineOffset: -1,
  },
  sm: { height: size.progressSm },
  md: { height: size.progressDefault },
  lg: { height: size.progressLg },
  indicator: {
    "--progress-line-sign": { default: "1", ":dir(rtl)": "-1" },
    height: "100%",
    borderRadius: "inherit",
    // How far unknown, the light below draws it; only forced colours keep this solid third.
    backgroundColor: {
      default: progressVars.color,
      [UNKNOWN]: { default: "transparent", [FORCED]: "CanvasText" },
    },
    forcedColorAdjust: "none",
    transitionProperty: "width",
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
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
    animationDuration: duration.progressSweep,
    animationTimingFunction: duration.easeInOut,
    animationIterationCount: "infinite",
  },
  // How far unknown: where the light shows, the track's pixels at 2px, standing still while the
  // band moves under them, so the pixels light up rather than slide.
  unknownLit: {
    position: "absolute",
    inset: 0,
    display: { default: "block", [FORCED]: "none", [REDUCED]: "none" },
    maskImage: pixel.mask,
    maskSize: UNKNOWN_PITCH,
    maskPosition: UNKNOWN_START,
  },
  unknownBand: {
    "--progress-line-sign": { default: "1", ":dir(rtl)": "-1" },
    position: "absolute",
    insetBlock: 0,
    insetInlineStart: 0,
    width: "calc(100% / 3)",
    backgroundImage: UNKNOWN_BAND,
    animationName: { default: sweep, [REDUCED]: "none", [FORCED]: "none" },
    animationDuration: duration.progressSweep,
    animationTimingFunction: duration.easeInOut,
    animationIterationCount: "infinite",
  },
  // A variant's light is the variant's own colour, fading in and out.
  unknownBandVariant: {
    backgroundImage: `linear-gradient(90deg, transparent 0%, ${progressVars.color} 50%, transparent 100%)`,
  },

  // ---- The ring ----
  // A conic fill up to the value, cut to a ring by a mask: no drawing, the value is the angle.
  ring: {
    gridArea: "1 / 1",
    position: "relative",
    display: "grid",
    placeItems: "center",
    borderRadius: radius.circle,
    backgroundImage: {
      default: `conic-gradient(${progressVars.color} var(--progress-value, 0%), ${colors.progressRingTrack} 0)`,
      [UNKNOWN]: `conic-gradient(${progressVars.color} 25%, ${colors.progressRingTrack} 0)`,
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
      default: duration.spin,
      [REDUCED]: duration.progressSweep,
    },
    animationTimingFunction: {
      default: "linear",
      [REDUCED]: duration.easeInOut,
    },
    animationIterationCount: "infinite",
  },
  ringSm: {
    width: size.progressRingSm,
    height: size.progressRingSm,
    mask: `radial-gradient(farthest-side, transparent calc(100% - ${size.progressRingLine}), #000 calc(100% - ${size.progressRingLine} + 0.5px))`,
  },
  ringMd: {
    width: size.progressRingDefault,
    height: size.progressRingDefault,
    mask: `radial-gradient(farthest-side, transparent calc(100% - ${size.progressRingLine}), #000 calc(100% - ${size.progressRingLine} + 0.5px))`,
  },
  ringLg: {
    width: size.progressRingLg,
    height: size.progressRingLg,
    mask: `radial-gradient(farthest-side, transparent calc(100% - ${size.progressRingLineLg}), #000 calc(100% - ${size.progressRingLineLg} + 0.5px))`,
  },
  // The large ring's value, in its middle. It stands over the ring, which its mask would cut.
  ringValue: {
    gridArea: "1 / 1",
    placeSelf: "center",
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
    fontVariantNumeric: "tabular-nums",
  },
});

const variants = {
  default: styles.default,
  success: styles.success,
  warning: styles.warning,
  destructive: styles.destructive,
};
const bars = { sm: styles.sm, default: styles.md, lg: styles.lg };
const rings = { sm: styles.ringSm, default: styles.ringMd, lg: styles.ringLg };

/** Whether how far is known: a ProgressValue shows nothing while it is not. */
const KnownContext = createContext(false);

/** What is under way, above the bar: it names the bar. */
export const ProgressLabel = ({ children }: ProgressLabelProps) => (
  <ProgressLabelPrimitive {...stylex.props(styles.label)}>
    {children}
  </ProgressLabelPrimitive>
);

/** How far it has come, at the end of the label's line: the percentage, unseen by a screen reader, which hears the bar's own value. */
export const ProgressValue = ({ children }: ProgressValueProps) =>
  use(KnownContext) ? (
    <ProgressValuePrimitive aria-hidden="true" {...stylex.props(styles.value)}>
      {children === undefined
        ? undefined
        : (state): ReactNode => children(state.text, state.value)}
    </ProgressValuePrimitive>
  ) : null;

export const Progress = ({
  value,
  max = 100,
  children,
  "aria-label": ariaLabel,
  variant = "default",
  size: sized = "default",
  getAriaValueText,
  style,
}: ProgressProps) => (
  <ProgressPrimitive
    value={value}
    max={max}
    aria-label={ariaLabel}
    getValueLabel={getAriaValueText}
    {...stylex.props(styles.root, variants[variant], style)}
  >
    <KnownContext value={value !== null}>{children}</KnownContext>
    <ProgressTrack {...stylex.props(styles.track, bars[sized])}>
      {/* The class only: UI SDK sets the indicator's width as its own inline style. */}
      <ProgressIndicator className={className(styles.indicator)} />
      {value === null ? (
        <span aria-hidden="true" {...stylex.props(styles.unknownLit)}>
          <span
            {...stylex.props(
              styles.unknownBand,
              variant !== "default" && styles.unknownBandVariant
            )}
          />
        </span>
      ) : null}
    </ProgressTrack>
  </ProgressPrimitive>
);

export const ProgressCircle = ({
  value,
  max = 100,
  "aria-label": ariaLabel,
  showValue = true,
  variant = "default",
  size: sized = "default",
  getAriaValueText,
  style,
}: ProgressCircleProps) => (
  <ProgressPrimitive
    // UI SDK names its root `progress`; the ring is its own part, so it takes its own name.
    render={<div data-slot="progress-circle" />}
    value={value}
    max={max}
    aria-label={ariaLabel}
    getValueLabel={getAriaValueText}
    {...stylex.props(styles.root, styles.rootCircle, variants[variant], style)}
  >
    {/* The track is the ring; the indicator part is kept, unseen, so the value stays wired. */}
    <ProgressTrack {...stylex.props(styles.ring, rings[sized])}>
      <ProgressIndicator className={className(visuallyHidden)} />
    </ProgressTrack>
    {showValue && sized === "lg" && value !== null && (
      <ProgressValuePrimitive
        aria-hidden="true"
        {...stylex.props(styles.ringValue)}
      />
    )}
  </ProgressPrimitive>
);
