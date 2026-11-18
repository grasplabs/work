// Slider: a number or a range along a scale, from shadcn's (registry/bases/base/ui/slider.tsx, on
// Base UI), converted from Tailwind to StyleX and rebuilt on UI SDK's Slider: a native range input
// in each thumb, so the keys, a screen reader's gestures and an agent all move it. Palermo has no
// slider; it is drawn from Palermo's switch: a soft track, the ink range, a white thumb with the
// low lift. Its label and the value stand on one line above it.
//
//   <Slider label="Volume" defaultValue={40} />
//   <Slider label="Price" defaultValue={[20, 80]} thumbLabels={["Lowest price", "Highest price"]} />
//   <Slider label="Share of the budget" defaultValue={0.3} max={1} step={0.01} format={{ style: "percent" }} />
//
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import {
  Field as FieldPrimitive,
  FieldLabel as FieldLabelPrimitive,
} from "@ui-sdk/react/field";
import {
  Slider as SliderPrimitive,
  SliderControl,
  SliderIndicator,
  SliderThumb,
  SliderTrack,
  SliderValue,
} from "@ui-sdk/react/slider";
import type { ComponentProps, ReactNode } from "react";

import { FieldDescription } from "../field";
import { labelStyles } from "../label/label";
import type { LayoutStyle } from "../layout/layout";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { sliderMarker } from "./slider.stylex";

/** What a caller may style: where the slider sits, and how wide it is. Never its look. */
export type SliderLayoutStyle = LayoutStyle;

type SliderPrimitiveProps = ComponentProps<typeof SliderPrimitive>;

/** A slider's value: a number for one thumb, two for a range. */
export type SliderValueType = number | number[];

/** Every prop a Slider takes. */
interface SliderOwnProps {
  /** What it sets, in sentence case ("Volume"). It names a single thumb, and a range's group. */
  label: ReactNode;
  /** One sentence under it: what the number changes. A screen reader says it after the name. */
  description?: ReactNode;
  /**
   * For a range, one name per thumb, in order ("Lowest price", "Highest price"). A screen reader
   * and an agent find each by these words.
   */
  thumbLabels?: string[];
  /**
   * Shows the value beside the label, formatted with `format`.
   * @default true
   */
  showValue?: boolean;
  /** The value now, for a slider your code holds: a number, or two for a range. */
  value?: SliderValueType;
  /** The value at first, when the slider holds its own: a number, or two for a range. */
  defaultValue?: SliderValueType;
  /** Runs on every step of a drag or a key, with the new value and which thumb moved. */
  onValueChange?: SliderPrimitiveProps["onValueChange"];
  /** Runs once a drag or a key press ends. */
  onValueCommit?: SliderPrimitiveProps["onValueCommit"];
  /**
   * The lowest value.
   * @default 0
   */
  min?: number;
  /**
   * The highest value.
   * @default 100
   */
  max?: number;
  /**
   * How far one step moves.
   * @default 1
   */
  step?: number;
  /** How the value reads, beside the label and to a screen reader: Intl.NumberFormat options. */
  format?: SliderPrimitiveProps["format"];
  /**
   * Out of use: no drag, no focus, half strength. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /** @deprecated Use `layout`. */
  style?: SliderLayoutStyle;
  /** Layout only: margins, alignment and width. The look belongs to the slider. */
  layout?: SliderLayoutStyle;
}

/** Every prop a Slider takes: the ones above, and the rest of UI SDK's Slider. */
export type SliderProps = SliderOwnProps &
  Omit<
    SliderPrimitiveProps,
    keyof SliderOwnProps | "className" | "children" | "render"
  >;

const styles = stylex.create({
  field: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: grasp.space1,
    minWidth: 0,
    margin: 0,
  },
  slider: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    minWidth: 0,
  },
  // The label, then the value at the end of the same line.
  head: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: grasp.space3,
    minWidth: 0,
  },
  value: {
    flexShrink: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
    fontVariantNumeric: "tabular-nums",
  },
  // Where a press lands: 44px tall round the thin track, so a finger finds it.
  control: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    height: grasp.tap,
    // Half a thumb at each end, so a thumb at either end stays inside the field.
    paddingInline: `calc(${grasp.sliderThumb} / 2)`,
    touchAction: "none",
    cursor: "pointer",
  },
  still: {
    cursor: "default",
  },
  track: {
    position: "relative",
    flexGrow: 1,
    height: grasp.sliderTrack,
    borderRadius: grasp.cornerPill,
    backgroundColor: {
      default: grasp.switchTrack,
      // Under a pointer, the track darkens a step, as a switch's does.
      [stylex.when.ancestor(":hover", sliderMarker)]: {
        default: null,
        [media.hover]: grasp.switchTrackHover,
      },
      [media.forced]: "GrayText",
    },
  },
  // Out of use: no hover.
  trackStill: {
    backgroundColor: { default: grasp.switchTrack, [media.forced]: "GrayText" },
  },
  indicator: {
    height: "100%",
    borderRadius: grasp.cornerPill,
    backgroundColor: { default: grasp.actionFill, [media.forced]: "Highlight" },
  },
  // UI SDK places and centres the thumb on its point along the track (inline styles, right to
  // left included); this gives it its size and look.
  thumb: {
    width: grasp.sliderThumb,
    height: grasp.sliderThumb,
    boxSizing: "border-box",
    borderRadius: grasp.cornerCircle,
    // In forced colours the thumb is the page colour inside a line, so the ring round it shows.
    backgroundColor: { default: grasp.onFill, [media.forced]: "Canvas" },
    borderWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    // Its lift and an edge one step stronger than a box's: page-white on a light page, a hairline
    // alone let it all but vanish.
    boxShadow: `0 0 0 ${grasp.hairline} ${grasp.choiceEdgeHover}, ${grasp.liftLow}`,
    // The focus is on the range input inside it: the ring is drawn here, with the shared ring's
    // values (src/focus), when focus is within. A thumb is a small mark: the ring stands off it,
    // as focus.mark does, so it is not lost on the thumb's own edge.
    outline: {
      default: "none",
      ":has(:focus-visible)": `${grasp.ringWidth} solid ${grasp.ring}`,
    },
    outlineOffset: grasp.ringOffsetMark,
    transitionProperty: "transform",
    transitionDuration: simply.press,
    transitionTimingFunction: grasp.ease,
    // A finger needs 44px: on touch an unseen area round the 16px thumb, so a press beside it
    // still takes the thumb. Nothing drawn changes.
    "::after": {
      content: "''",
      position: "absolute",
      inset: {
        default: 0,
        [media.coarse]: `calc((${grasp.sliderThumb} - ${grasp.tap}) / 2)`,
      },
      borderRadius: grasp.cornerCircle,
    },
    // Pressed or dragged: one step smaller, as every control presses.
    transform: {
      default: "none",
      ":active": `scale(${grasp.pressScale})`,
      ":is([data-dragging])": `scale(${grasp.pressScale})`,
    },
  },
  disabled: {
    opacity: grasp.dim,
  },
});

export const Slider = ({
  label,
  description,
  thumbLabels,
  showValue = true,
  style: styleProp,
  layout,
  disabled = false,
  ...rest
}: SliderProps) => {
  const start = rest.value ?? rest.defaultValue ?? 0;
  const thumbs = Array.isArray(start) ? start.length : 1;
  return (
    <FieldPrimitive
      disabled={disabled}
      {...stylex.props(styles.field, layout ?? styleProp)}
    >
      <SliderPrimitive
        {...rest}
        disabled={disabled}
        {...stylex.props(styles.slider)}
      >
        <div {...stylex.props(styles.head)}>
          <FieldLabelPrimitive {...stylex.props(labelStyles.label)}>
            {label}
          </FieldLabelPrimitive>
          {showValue && (
            <SliderValue
              {...stylex.props(styles.value, disabled && styles.disabled)}
            />
          )}
        </div>
        <SliderControl
          {...stylex.props(
            sliderMarker,
            styles.control,
            disabled && styles.still,
            disabled && styles.disabled
          )}
        >
          <SliderTrack
            {...stylex.props(styles.track, disabled && styles.trackStill)}
          >
            <SliderIndicator {...stylex.props(styles.indicator)} />
            {Array.from({ length: thumbs }, (_, index) => (
              <SliderThumb
                // The thumbs are positions, never reordered: the index is their identity.
                key={index}
                index={index}
                aria-label={thumbs > 1 ? thumbLabels?.[index] : undefined}
                {...stylex.props(styles.thumb)}
              />
            ))}
          </SliderTrack>
        </SliderControl>
      </SliderPrimitive>
      {description !== undefined && (
        <FieldDescription>{description}</FieldDescription>
      )}
    </FieldPrimitive>
  );
};
