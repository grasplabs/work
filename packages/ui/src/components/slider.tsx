// Slider: a number or a range along a scale,
// in StyleX, built on UI SDK's Slider: a native range input in
// each thumb, so the keys, a screen reader's gestures and an agent all move it. A soft track, the
// ink range, a white thumb with the low lift; its label and the value stand on one line above it.
//
//   <Slider defaultValue={40}><SliderLabel>Volume</SliderLabel></Slider>
//   <Slider defaultValue={[20, 80]} thumbLabels={["Lowest price", "Highest price"]}>
//     <SliderLabel>Price</SliderLabel>
//   </Slider>
//   <Field><FieldLabel>Volume</FieldLabel><Slider defaultValue={40} /></Field>   the Field labels it
//
// `variant="levels"` is one of a short, named scale (two to seven levels), chosen along a round
// track of dots, built for effort (Low, Medium, High, Extra high, Max):
//
//   <Slider variant="levels" levels={levels} defaultValue="medium">
//     <SliderLabel>Effort</SliderLabel>
//   </Slider>
//   <Slider variant="levels" aria-label="Effort" levels={levels} />   no words over the track
//
// Its track is filled with a halftone of dots: up to the thumb they are lit, the ink and its deeper
// green, growing further along so more reads as more; the last few before the thumb glow warm. Past
// the thumb they rest, small and faint. The thumb is a round tab of the card's surface, snapping to
// a level's place. The scale's two ends are named under it; the chosen level is said in words to a
// screen reader. The top level (`top`) is its own state: the dots take the working light, a wave
// runs along them, and the thumb glows; with reduced motion the wave stands still. The keyboard and
// a screen reader move a native range input in the thumb: arrows step, Home and End jump.
"use client";

import * as stylex from "@stylexjs/stylex";
import { Field as FieldPrimitive } from "@ui-sdk/react/field";
import {
  Slider as SliderPrimitive,
  SliderControl,
  SliderIndicator,
  SliderThumb,
  SliderTrack,
  SliderValue as SliderValuePrimitive,
} from "@ui-sdk/react/slider";
import { createContext, use, useEffect, useId, useRef, useState } from "react";
import type {
  ChangeEvent,
  ComponentProps,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
  RefObject,
} from "react";

import { visuallyHidden } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "../lib/tokens.stylex";
import { warnUnnamed } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { motionVars } from "../lib/vars.stylex";
import { FieldDescription, FieldLabel } from "./field";
import { sliderLevelsMarker, sliderMarker } from "./slider.stylex";

type SliderPrimitiveProps = ComponentProps<typeof SliderPrimitive>;

/** A slider's value: a number for one thumb, two for a range. */
export type SliderValue = number | number[];

/** One level of a levels slider's scale. */
export interface SliderLevel {
  /** What `onValueChange` receives ("medium"). */
  id: string;
  /** Its name ("Medium"): the ends' names stand under the track; each is said to a screen reader. */
  label: string;
  /** One line on what it means, shown under the slider while it is chosen. */
  description?: string;
}

/** The props of a slider along a scale of numbers. */
interface SliderDefaultOwnProps {
  /**
   * `default`: a number or a range along a scale. `levels`: one of a short named scale, along a
   * round track of dots, with `levels`.
   * @default "default"
   */
  variant?: "default";
  /**
   * Its SliderLabel: what it sets, in sentence case ("Volume"). It names a single thumb, and a
   * range's group. Leave it out inside a Field: its FieldLabel names the slider. Levels: a quiet
   * word above the track, the SliderLabel written straight in it, or `aria-label` in its place.
   */
  children?: ReactNode;
  /** One sentence under it: what the number changes. A screen reader says it after the name. */
  description?: ReactNode;
  /**
   * For a range, one name per thumb, in order ("Lowest price", "Highest price"). A screen reader
   * and an agent find each by these words.
   */
  thumbLabels?: string[];
  /**
   * Shows the value beside the label, formatted with `format`. Only with a SliderLabel.
   * @default true
   */
  showValue?: boolean;
  /**
   * The value now, for a slider your code holds: a number, or two for a range. Levels: the chosen
   * level's id.
   */
  value?: SliderValue;
  /**
   * The value at first, when the slider holds its own: a number, or two for a range. Levels: a
   * level's id, the first when left out.
   */
  defaultValue?: SliderValue;
  /**
   * Runs on every step of a drag or a key, with the new value and which thumb moved. Levels: with
   * the new level's id, by a drag, a press or a key.
   */
  onValueChange?: SliderPrimitiveProps["onValueChange"];
  /** Runs once a drag or a key press ends. */
  onValueCommitted?: SliderPrimitiveProps["onValueCommit"];
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
   * Which way it runs. A vertical slider takes its height from `style`, and is four touch targets
   * tall at least.
   * @default "horizontal"
   */
  orientation?: "horizontal" | "vertical";
  /**
   * Out of use: no drag, no focus, half strength. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /** Layout only: margins, alignment and width. The look belongs to the slider. */
  style?: LayoutStyle;
}

/** The props of a levels slider: one of a short named scale. */
interface SliderLevelsBase {
  // Each prop it shares with the default slider is documented there, once, for both.
  variant: "levels";
  /** The levels, lowest first: two to seven. Fewer than two shows `emptyText` and no control. */
  levels: readonly SliderLevel[];
  value?: string | undefined;
  defaultValue?: string | undefined;
  onValueChange?: ((value: string) => void) | undefined;
  /**
   * The last level is its own state while chosen (the working light in the dots, a wave, the thumb
   * aglow): `true`, `false`, or `"auto"`, on for four levels or more (a short scale's last step is
   * not extra). Levels only.
   * @default "auto"
   */
  top?: boolean | "auto";
  /**
   * `sm` (a 24px track) inside a popup or a menu, `default` (32px) on a page. Levels only.
   * @default "default"
   */
  size?: "sm" | "default";
  disabled?: boolean;
  /** The line shown instead of the control when there are fewer than two levels. Levels only. */
  emptyText?: ReactNode;
  style?: LayoutStyle;
}

/**
 * A levels slider with its name over the track.
 * @when levels, with a SliderLabel
 */
interface SliderLevelsLabelled extends SliderLevelsBase {
  children: ReactElement<SliderLabelProps>;
  "aria-label"?: never;
}

/**
 * A levels slider the words round it already name.
 * @when levels, without a SliderLabel
 */
interface SliderLevelsNamed extends SliderLevelsBase {
  children?: never;
  /** What it sets ("Effort"), when no SliderLabel stands over the track. Levels only. */
  "aria-label": string;
}

type SliderLevelsProps = SliderLevelsLabelled | SliderLevelsNamed;

/** Every prop a SliderLabel takes. */
export interface SliderLabelProps {
  /** What the slider sets, in sentence case ("Volume"). */
  children: ReactNode;
}

type SliderDefaultProps = SliderDefaultOwnProps &
  Omit<
    SliderPrimitiveProps,
    | keyof SliderDefaultOwnProps
    | "onValueCommit"
    | "className"
    | "children"
    | "render"
  >;

/** Every prop a Slider takes: a scale of numbers (the rest of UI SDK's Slider too), or of levels. */
export type SliderProps = SliderDefaultProps | SliderLevelsProps;

// ---- The default slider ----------------------------------------------------------------------------

const FORCED = media.forcedColors;
const COARSE = media.pointerCoarse;
const HOVER = media.hover;

const styles = stylex.create({
  field: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: space[1],
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
    gap: space[3],
    minWidth: 0,
  },
  value: {
    flexShrink: 0,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
  },
  // Where a press lands: 44px tall round the thin track, so a finger finds it.
  control: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    height: size.tapTarget,
    // Half a thumb at each end, so a thumb at either end stays inside the field.
    paddingInline: `calc(${size.sliderThumb} / 2)`,
    touchAction: "none",
    cursor: "pointer",
  },
  // Upright: 44px wide, the run along its height, half a thumb in at each end.
  controlVertical: {
    flexDirection: "column",
    justifySelf: "start",
    width: size.tapTarget,
    height: "100%",
    minHeight: `calc(4 * ${size.tapTarget})`,
    paddingInline: 0,
    paddingBlock: `calc(${size.sliderThumb} / 2)`,
    boxSizing: "border-box",
  },
  still: {
    cursor: "default",
  },
  track: {
    position: "relative",
    flexGrow: 1,
    height: size.sliderTrack,
    borderRadius: radius.full,
    backgroundColor: {
      default: colors.switchTrack,
      // Under a pointer, the track darkens a step, as a switch's does.
      [stylex.when.ancestor(":hover", sliderMarker)]: {
        default: null,
        [HOVER]: colors.switchTrackHover,
      },
      [FORCED]: "GrayText",
    },
  },
  trackVertical: {
    width: size.sliderTrack,
    height: "auto",
  },
  // Out of use: no hover.
  trackStill: {
    backgroundColor: { default: colors.switchTrack, [FORCED]: "GrayText" },
  },
  indicator: {
    height: "100%",
    borderRadius: radius.full,
    backgroundColor: { default: colors.primary, [FORCED]: "Highlight" },
  },
  // Upright, UI SDK sets the indicator's height; it fills the track's width.
  indicatorVertical: {
    width: "100%",
    height: null,
  },
  // UI SDK places and centres the thumb on its point along the track (inline styles, right to
  // left included); this gives it its size and look.
  thumb: {
    width: size.sliderThumb,
    height: size.sliderThumb,
    boxSizing: "border-box",
    borderRadius: radius.circle,
    // In forced colours the thumb is the page colour inside a line, so the ring round it shows.
    backgroundColor: {
      default: colors.primaryForegroundOnColor,
      [FORCED]: "Canvas",
    },
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    // Its lift and an edge one step stronger than a box's: page-white on a light page, a hairline
    // alone let it all but vanish.
    boxShadow: `0 0 0 ${size.hairline} ${colors.controlBorderHover}, ${shadow.sm}`,
    // The focus is on the range input inside it: the ring is drawn here when focus is within. A
    // thumb is a small mark: the ring stands off it, so it is not lost on the thumb's own edge.
    outline: {
      default: "none",
      ":has(:focus-visible)": `${size.ringWidth} solid ${colors.ring}`,
    },
    outlineOffset: size.ringOffsetMark,
    transitionProperty: "transform",
    transitionDuration: motionVars.press,
    transitionTimingFunction: duration.ease,
    // A finger needs 44px: on touch an unseen area round the 16px thumb, so a press beside it
    // still takes the thumb. Nothing drawn changes.
    "::after": {
      content: "''",
      position: "absolute",
      inset: {
        default: 0,
        [COARSE]: `calc((${size.sliderThumb} - ${size.tapTarget}) / 2)`,
      },
      borderRadius: radius.circle,
    },
    // Pressed or dragged: one step smaller, as every control presses.
    transform: {
      default: "none",
      ":active": `scale(${size.buttonPressScale})`,
      ":is([data-dragging])": `scale(${size.buttonPressScale})`,
    },
  },
  disabled: {
    opacity: size.opacityDisabled,
  },
});

/** The track, its range and its thumbs: one thumb per number in the value. */
const SliderRail = ({
  thumbs,
  thumbLabels,
  vertical,
  disabled,
}: {
  thumbs: number;
  thumbLabels: string[] | undefined;
  vertical: boolean;
  disabled: boolean;
}) => (
  <SliderControl
    {...stylex.props(
      sliderMarker,
      styles.control,
      vertical && styles.controlVertical,
      disabled && styles.still,
      disabled && styles.disabled
    )}
  >
    <SliderTrack
      {...stylex.props(
        styles.track,
        vertical && styles.trackVertical,
        disabled && styles.trackStill
      )}
    >
      <SliderIndicator
        {...stylex.props(
          styles.indicator,
          vertical && styles.indicatorVertical
        )}
      />
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
);

/** Which slider a SliderLabel stands in: it draws that slider's label. */
const LabelContext = createContext<
  | { variant: "default" }
  | { variant: "levels"; id: string | undefined; large: boolean }
  | undefined
>(undefined);

const DEFAULT_LABEL = { variant: "default" } as const;

/** A number or a range along a scale. */
const DefaultSlider = ({
  variant: _variant,
  children,
  description,
  thumbLabels,
  showValue = true,
  orientation = "horizontal",
  style,
  disabled = false,
  onValueCommitted,
  ...rest
}: SliderDefaultProps) => {
  const start = rest.value ?? rest.defaultValue ?? 0;
  const labelled =
    children !== undefined && children !== null && children !== false;
  const slider = (
    <SliderPrimitive
      {...rest}
      onValueCommit={onValueCommitted}
      orientation={orientation}
      disabled={disabled}
      {...stylex.props(styles.slider, !labelled && style)}
    >
      {labelled && (
        <div {...stylex.props(styles.head)}>
          <LabelContext value={DEFAULT_LABEL}>{children}</LabelContext>
          {showValue && (
            <SliderValuePrimitive
              {...stylex.props(styles.value, disabled && styles.disabled)}
            />
          )}
        </div>
      )}
      <SliderRail
        thumbs={Array.isArray(start) ? start.length : 1}
        thumbLabels={thumbLabels}
        vertical={orientation === "vertical"}
        disabled={disabled}
      />
    </SliderPrimitive>
  );
  const note = description !== undefined && (
    <FieldDescription>{description}</FieldDescription>
  );
  // Without a label of its own, the Field round it names and describes it.
  if (!labelled) {
    return (
      <>
        {slider}
        {note}
      </>
    );
  }
  return (
    <FieldPrimitive disabled={disabled} {...stylex.props(styles.field, style)}>
      {slider}
      {note}
    </FieldPrimitive>
  );
};

// ---- The levels slider: its halftone ---------------------------------------------------------------
//
// A field of dots across the track, one on every slider-levels-pitch, each with a size drawn from
// its own seed, so the field reads as printed light rather than a grid. When the level changes the
// lit edge pours to its new place in slider-levels-snap (ease-out). Every dot lands on whole device
// pixels: the canvas is the track's size times the display's ratio. It draws on change only, plus
// the breathing at the top level while it is in view.

/** What the field shows. */
interface LevelFieldState {
  /** Where the lit part ends, 0 to 1 along the track. */
  fill: number;
  /** The top level is chosen and carries the light: the dots breathe. */
  top: boolean;
}

/** A field being drawn. */
interface LevelField {
  set: (state: LevelFieldState) => void;
  stop: () => void;
}

/** How many columns before the thumb's body may glow warm, and how many warm dots at most. */
const WARM_COLUMNS = 2;
const MAX_WARM = 5;
/** How long the lit edge takes to reach a new place, in ms. Matches slider-levels-snap. */
const POUR = 160;
/** One pass of the top level's wave along the track, in seconds: slow, so it never draws the eye. */
const BREATH = 4.8;

/** The custom property a token names ("--damsko-slider-levels-pitch"), to read it from a style. */
const propertyOf = (token: string) =>
  /var\((?<name>--[^),\s]+)/u.exec(token)?.groups?.name ?? "";

/** A length token as the browser resolves it on `element`, in px; `fallback` when it reads none. */
const pxOf = (element: Element, token: string, fallback: number) =>
  Number(
    getComputedStyle(element)
      .getPropertyValue(propertyOf(token))
      .trim()
      .replace("px", "")
  ) || fallback;

/** The fraction after the point. */
const fract = (value: number) => value - Math.floor(value);

/** A dot's seed, 0 to 1, the same every frame: its size and its colour come from it. */
const seed = (column: number, row: number) => {
  // Two passes of the classic sine hash, the second fed by the first, so no stripes show.
  const first = fract(Math.sin(column * 12.9898 + row * 78.233) * 43_758.5453);
  return fract(
    Math.sin(first * 91.3458 + column * 0.371 + row * 1.137) * 47_453.5453
  );
};

/** One dot as it is drawn: its size, colour and strength. */
interface Dot {
  radius: number;
  colour: string;
  alpha: number;
}

/** The colours the field takes, as the page's tokens resolve here. */
interface Palette {
  /** The working light's stops, for the top level. */
  light: string[];
  deep: string;
  ink: string;
  warm: string;
  rest: string;
  restAlpha: number;
}

/** How a lit dot below the top level looks: the ink or its deeper green, or one of the warm few. */
const litDot = (
  n: number,
  biggest: number,
  grow: number,
  palette: Palette,
  glows: boolean
): Dot => {
  const ink = n > 0.55 ? palette.ink : palette.deep;
  // An even halftone with a gentle change: sizes in a narrow spread.
  return {
    radius: biggest * (0.62 + 0.38 * n) * grow,
    colour: glows ? palette.warm : ink,
    alpha: 1,
  };
};

/** How a lit dot at the top level looks: the working light, its lighter stop carried by the wave. */
const topDot = (
  n: number,
  biggest: number,
  palette: Palette,
  wave: number
): Dot => {
  const [base, crest, other] = palette.light;
  let colour = base;
  if (wave > 0.6) {
    colour = crest;
  } else if (n > 0.7) {
    colour = other;
  }
  return {
    radius: biggest * (0.7 + 0.3 * n),
    colour: colour ?? palette.ink,
    alpha: 1,
  };
};

/** How a resting dot looks, past the thumb: small and faint. */
const restDot = (n: number, biggest: number, palette: Palette): Dot => ({
  radius: biggest * (0.4 + 0.3 * n),
  colour: palette.rest,
  alpha: palette.restAlpha + 0.12 * n,
});

/** How likely a dot is to glow warm: in the two columns just before the thumb's body, most in the nearer. */
const warmChanceOf = (before: number) => {
  if (before <= 0 || before > WARM_COLUMNS) {
    return 0;
  }
  return before <= 1 ? 0.4 : 0.15;
};

const paletteOf = (canvas: HTMLCanvasElement): Palette => {
  const style = getComputedStyle(canvas);
  // A token resolved by the browser (light-dark() and all), read back as a plain colour.
  const token = (value: string) => {
    canvas.style.outlineColor = value;
    const resolved = getComputedStyle(canvas).outlineColor;
    canvas.style.outlineColor = "";
    return resolved;
  };
  // The canvas's colour is the ink: light ink means a dark page. Painted once to read it as sRGB,
  // whatever form the colour is written in.
  let dark = false;
  const probe = document.createElement("canvas").getContext("2d");
  if (probe !== null) {
    probe.fillStyle = style.color;
    probe.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
    dark = r + g + b > 384;
  }
  return dark
    ? {
        light: [
          token(colors.brandMint),
          token(colors.brandLime),
          token(colors.brandSea),
        ],
        deep: token(colors.brandMint),
        ink: token(colors.brandLime),
        warm: token(colors.sliderLevelsWarm),
        rest: token(colors.brandPaper),
        restAlpha: 0.2,
      }
    : {
        light: [
          token(colors.mintDeep),
          token(colors.brandMint),
          token(colors.brandPine),
        ],
        deep: token(colors.brandPine),
        ink: token(colors.brandInk),
        warm: token(colors.sliderLevelsWarm),
        rest: token(colors.brandInk),
        restAlpha: 0.16,
      };
};

/** Starts drawing the field on `canvas`, sized to `track`. */
const startLevelField = (
  canvas: HTMLCanvasElement,
  track: HTMLElement
): LevelField => {
  const ctx = canvas.getContext("2d");
  let state: LevelFieldState = { fill: 0, top: false };
  let shown = 0;
  let pourFrom = 0;
  let pourStart = 0;
  let frame = 0;
  let width = 0;
  let height = 0;
  let ratio = 1;
  let pitch = 4;
  let runInset = 2;
  let thumbInset = 3;
  let palette = paletteOf(canvas);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let inView = true;

  const fit = () => {
    const box = track.getBoundingClientRect();
    ratio = window.devicePixelRatio || 1;
    ({ width, height } = box);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    pitch = pxOf(track, size.sliderLevelsPitch, 4);
    runInset = pxOf(track, size.sliderLevelsRunPadding, 2);
    thumbInset = pxOf(track, size.sliderLevelsThumbPadding, 3);
  };

  const draw = (now: number) => {
    if (ctx === null || width === 0) {
      return;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const rtl = getComputedStyle(track).direction === "rtl";
    // The dots fill the track's own round shape: right into the round ends, each dot kept only
    // when it lies inside the pill, a little in from its edge, so the field is round as the track is.
    const inset = pitch / 2;
    const cap = height / 2;
    const room = cap - pitch * 1.1;
    const inside = (along: number, y: number) => {
      const centre = Math.min(Math.max(along, cap), width - cap);
      return Math.hypot(along - centre, y - cap) <= room;
    };
    const rows = Math.max(1, Math.floor((height - pitch) / pitch));
    const columns = Math.max(1, Math.floor((width - 2 * inset) / pitch) + 1);
    const top = (height - (rows - 1) * pitch) / 2;
    // The lit part ends at the thumb's centre, which travels between the two round ends, kept a
    // little short of them (slider-levels-run-padding) so the thumb's ring stays inside.
    const edge = cap + runInset + shown * (width - height - 2 * runInset);
    // Where the thumb's round body ends, toward the start: the warm dots stand just before it.
    const body = edge - (cap - thumbInset);
    const breath = state.top && !reduced.matches ? now / 1000 / BREATH : 0;
    // No two dots touch: the largest is its cell less a pixel.
    const biggest = (pitch - 1) / 2;
    let warmth = 0;
    for (let column = 0; column < columns; column += 1) {
      const along = inset + column * pitch;
      const x = rtl ? width - along : along;
      const lit = along <= edge + 0.5;
      // Further along, the lit dots grow a touch: more reads as more, quietly.
      const grow = 0.9 + 0.1 * (column / Math.max(1, columns - 1));
      const warmChance =
        lit && !state.top ? warmChanceOf((body - along) / pitch) : 0;
      for (let row = 0; row < rows; row += 1) {
        const n = seed(column, row);
        const y = top + row * pitch;
        // Outside the round shape, or a hole: a few in the lit part, more past the thumb.
        if (!inside(along, y) || n < (lit ? 0.12 : 0.25)) {
          continue;
        }
        let dot: Dot;
        if (!lit) {
          dot = restDot(n, biggest, palette);
        } else if (state.top) {
          // The top level: still with reduced motion, the wave standing where it is.
          dot = topDot(
            n,
            biggest,
            palette,
            Math.sin((along / Math.max(1, width) - breath) * Math.PI * 2 + n)
          );
        } else {
          const glows = warmth < MAX_WARM && seed(row, column) < warmChance;
          warmth += glows ? 1 : 0;
          dot = litDot(n, biggest, grow, palette, glows);
        }
        ctx.globalAlpha = dot.alpha;
        ctx.fillStyle = dot.colour;
        ctx.beginPath();
        ctx.arc(
          Math.round(x * ratio) / ratio,
          Math.round(y * ratio) / ratio,
          Math.max(0.5, dot.radius),
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  };

  const tick = (now: number) => {
    frame = 0;
    const pouring = now - pourStart < POUR && !reduced.matches;
    if (pouring) {
      const t = (now - pourStart) / POUR;
      shown = pourFrom + (state.fill - pourFrom) * (1 - (1 - t) ** 3);
    } else {
      shown = state.fill;
    }
    draw(now);
    if (
      (pouring || (state.top && !reduced.matches)) &&
      inView &&
      document.visibilityState === "visible"
    ) {
      frame = requestAnimationFrame(tick);
    }
  };

  const wake = () => {
    if (frame === 0) {
      frame = requestAnimationFrame(tick);
    }
  };

  const resized = new ResizeObserver(() => {
    fit();
    wake();
  });
  resized.observe(track);
  const seen = new IntersectionObserver((entries) => {
    inView = entries.some((entry) => entry.isIntersecting);
    if (inView) {
      wake();
    }
  });
  seen.observe(track);
  const recolour = () => {
    palette = paletteOf(canvas);
    wake();
  };
  const themeWatch = new MutationObserver(recolour);
  themeWatch.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class", "style"],
  });
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", recolour);
  document.addEventListener("visibilitychange", wake);
  fit();

  return {
    set: (next) => {
      if (next.fill !== state.fill) {
        pourFrom = shown;
        pourStart = performance.now();
      }
      state = next;
      wake();
    },
    stop: () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      seen.disconnect();
      themeWatch.disconnect();
      scheme.removeEventListener("change", recolour);
      document.removeEventListener("visibilitychange", wake);
    },
  };
};

// ---- The levels slider: its parts ------------------------------------------------------------------

const levelStyles = stylex.create({
  root: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    minWidth: 0,
    fontFamily: font.sans,
  },
  label: {
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
  labelDefault: {
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  // Where a press lands: 44px tall round the track, so a finger finds it.
  control: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    height: size.tapTarget,
    touchAction: "none",
    cursor: "pointer",
    userSelect: "none",
    WebkitTapHighlightColor: "transparent",
  },
  still: {
    cursor: "default",
    pointerEvents: "none",
  },
  // The track: soft and round, the dots drawn over it.
  track: {
    position: "relative",
    flexGrow: 1,
    minWidth: 0,
    height: size.sliderLevelsTrack,
    borderRadius: radius.full,
    backgroundColor: {
      default: colors.sliderLevelsRest,
      [FORCED]: "Canvas",
    },
    borderStyle: { default: "none", [FORCED]: "solid" },
    borderWidth: { default: 0, [FORCED]: 1 },
    borderColor: { default: null, [FORCED]: "CanvasText" },
  },
  trackDefault: {
    height: size.sliderLevelsTrackRegular,
  },
  canvas: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    color: colors.foreground,
    display: { default: "block", [FORCED]: "none" },
  },
  // In forced colours the part up to the thumb, plainly.
  forcedFill: {
    position: "absolute",
    insetBlock: 0,
    insetInlineStart: 0,
    borderRadius: "inherit",
    display: { default: "none", [FORCED]: "block" },
    backgroundColor: "Highlight",
  },
  fillTo: (place: string) => ({
    width: place,
  }),
  // The thumb: a round tab of the card's surface, standing just inside the track.
  thumb: {
    position: "absolute",
    top: size.sliderLevelsThumbPadding,
    bottom: size.sliderLevelsThumbPadding,
    aspectRatio: "1",
    // Centred on its place: inset-inline-start measures from the right in right to left, and a
    // translate is physical, so it goes the other way there.
    translate: { default: "-50% 0", ":dir(rtl)": "50% 0" },
    boxSizing: "border-box",
    borderRadius: radius.circle,
    backgroundColor: {
      default: colors.sliderLevelsThumb,
      [FORCED]: "Canvas",
    },
    boxShadow: {
      default: `0 0 0 ${size.hairline} ${colors.controlBorderHover}, ${shadow.sm}`,
      [stylex.when.ancestor(":hover", sliderLevelsMarker)]:
        `0 0 0 ${size.hairline} ${colors.mutedForeground}, ${shadow.md}`,
      [stylex.when.ancestor(":active", sliderLevelsMarker)]:
        `0 0 0 ${size.hairline} ${colors.mutedForeground}, ${shadow.sm}`,
    },
    borderStyle: { default: "none", [FORCED]: "solid" },
    borderWidth: { default: 0, [FORCED]: 2 },
    borderColor: { default: null, [FORCED]: "CanvasText" },
    // The focus is on the range input inside it: the shared ring, standing off the thumb.
    outline: {
      default: "none",
      ":has(:focus-visible)": {
        default: `${size.ringWidth} solid ${colors.ring}`,
        [FORCED]: `calc(2 * ${size.lineStrong}) solid Highlight`,
      },
    },
    outlineOffset: size.ringOffsetMark,
    // Under a pointer anywhere on the row the thumb grows a touch and lifts, to be taken hold of;
    // pressed, it gives a little and settles, as every control presses.
    scale: {
      default: null,
      [stylex.when.ancestor(":hover", sliderLevelsMarker)]:
        size.sliderLevelsHover,
      [stylex.when.ancestor(":active", sliderLevelsMarker)]:
        size.buttonPressScale,
    },
    transitionProperty: "inset-inline-start, scale, box-shadow",
    transitionDuration: motionVars.snap,
    transitionTimingFunction: duration.ease,
  },
  // At the top level the thumb glows with the working light, so the top is felt, not only read.
  thumbTop: {
    boxShadow: {
      default: `0 0 0 ${size.hairline} ${colors.mintDeep}, 0 0 ${space[3]} ${colors.mint}, ${shadow.sm}`,
      [FORCED]: "none",
    },
  },
  // A thumb follows a dragging pointer at once.
  thumbHeld: {
    transitionDuration: "0s",
    scale: size.buttonPressScale,
  },
  thumbAt: (place: string) => ({
    insetInlineStart: place,
  }),
  // The range input that the keyboard, a screen reader and an agent move: unseen, in the thumb.
  // As large as a finger's reach, centred on the thumb, as the row round it is.
  input: {
    position: "absolute",
    top: "50%",
    left: "50%",
    width: size.tapTarget,
    height: size.tapTarget,
    translate: "-50% -50%",
    margin: 0,
    opacity: 0,
    pointerEvents: "none",
    appearance: "none",
  },
  // The scale's two ends, named under the track, each under its end of the thumb's run.
  ends: {
    display: "flex",
    justifyContent: "space-between",
    gap: space[3],
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
  endOn: {
    color: colors.foreground,
    fontWeight: font.weightMedium,
  },
  note: {
    margin: 0,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
  disabled: {
    opacity: size.opacityDisabled,
  },
  // The empty line in the track's room and its ends' line, on the track's middle.
  emptyRoom: {
    display: "flex",
    alignItems: "center",
    minHeight: `calc(${size.tapTarget} + ${font.textXsLine})`,
    paddingBlockEnd: font.textXsLine,
    boxSizing: "border-box",
  },
});

/** The pointer's place along the track, 0 to 1, in reading order. */
const placeOf = (event: ReactPointerEvent, track: HTMLElement) => {
  const box = track.getBoundingClientRect();
  const rtl = getComputedStyle(track).direction === "rtl";
  const x = rtl ? box.right - event.clientX : event.clientX - box.left;
  // The thumb runs between the two round ends: half the track's height in from each, and the
  // run's own padding (slider-levels-run-padding), as the field and the thumb's place have it.
  const end = box.height / 2 + pxOf(track, size.sliderLevelsRunPadding, 0);
  return Math.min(1, Math.max(0, (x - end) / Math.max(1, box.width - 2 * end)));
};

/** The level nearest a place along the run. */
const levelAt = (place: number, count: number) =>
  Math.min(count - 1, Math.max(0, Math.round(place * (count - 1))));

/** Whether the last level carries the light. */
const topOn = (top: boolean | "auto", count: number) =>
  top === "auto" ? count >= 4 : top;

/** Where the thumb's centre stands, as CSS: between the round ends, kept a little short of them, by its share of the run. */
const thumbPlace = (share: number, large: boolean) => {
  const height = large ? size.sliderLevelsTrackRegular : size.sliderLevelsTrack;
  return `calc(${height} / 2 + ${size.sliderLevelsRunPadding} + (100% - ${height} - 2 * ${size.sliderLevelsRunPadding}) * ${share.toFixed(4)})`;
};

/** An effect with nothing to undo. */
const holdNothing = () => {
  // Nothing was started.
};

/** The halftone over the track: started once it is laid out, told of every change. */
const useLevelField = (
  canvas: RefObject<HTMLCanvasElement | null>,
  track: RefObject<HTMLDivElement | null>,
  fill: number,
  top: boolean
) => {
  const field = useRef<LevelField | null>(null);
  useEffect(() => {
    if (canvas.current === null || track.current === null) {
      return holdNothing;
    }
    const started = startLevelField(canvas.current, track.current);
    field.current = started;
    return () => {
      started.stop();
      field.current = null;
    };
  }, [canvas, track]);
  useEffect(() => {
    field.current?.set({ fill, top });
  }, [fill, top]);
};

/** The level chosen, held here unless the caller holds it. */
const useLevel = (
  levels: readonly SliderLevel[],
  value: string | undefined,
  defaultValue: string | undefined,
  onValueChange: ((value: string) => void) | undefined,
  disabled: boolean
) => {
  const [own, setOwn] = useState(defaultValue ?? levels[0]?.id ?? "");
  const chosen = value ?? own;
  const at = Math.max(
    0,
    levels.findIndex((level) => level.id === chosen)
  );
  const pick = (index: number) => {
    const level = levels[index];
    if (disabled || level === undefined || index === at) {
      return;
    }
    setOwn(level.id);
    onValueChange?.(level.id);
  };
  return { at, pick };
};

/** The track and its thumb: the row that takes a press or a drag, 44px tall. */
const LevelsTrack = ({
  levels,
  at,
  pick,
  disabled,
  large,
  lit,
  id,
  ariaLabel,
  input,
  describedBy,
}: {
  levels: readonly SliderLevel[];
  at: number;
  pick: (index: number) => void;
  disabled: boolean;
  large: boolean;
  lit: boolean;
  id: string;
  ariaLabel: string | undefined;
  input: RefObject<HTMLInputElement | null>;
  describedBy: string | undefined;
}) => {
  const [dragging, setDragging] = useState<number>();
  const track = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const count = levels.length;
  const share = dragging ?? at / (count - 1);
  useLevelField(canvas, track, share, lit);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0 || track.current === null) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const place = placeOf(event, track.current);
    setDragging(place);
    pick(levelAt(place, count));
    input.current?.focus({ preventScroll: true });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging === undefined || track.current === null) {
      return;
    }
    const place = placeOf(event, track.current);
    setDragging(place);
    pick(levelAt(place, count));
  };
  const onPointerEnd = () => {
    setDragging(undefined);
  };

  return (
    <div
      data-slot="slider-control"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      {...stylex.props(
        sliderLevelsMarker,
        levelStyles.control,
        disabled && levelStyles.still
      )}
    >
      <div
        ref={track}
        data-slot="slider-track"
        {...stylex.props(levelStyles.track, large && levelStyles.trackDefault)}
      >
        <canvas
          ref={canvas}
          aria-hidden="true"
          data-slot="slider-levels"
          {...stylex.props(levelStyles.canvas)}
        />
        <span
          aria-hidden="true"
          {...stylex.props(
            levelStyles.forcedFill,
            levelStyles.fillTo(thumbPlace(share, large))
          )}
        />
        <span
          data-slot="slider-thumb"
          data-held={dragging === undefined ? undefined : ""}
          {...stylex.props(
            levelStyles.thumb,
            lit && levelStyles.thumbTop,
            dragging !== undefined && levelStyles.thumbHeld,
            levelStyles.thumbAt(thumbPlace(share, large))
          )}
        >
          <input
            ref={input}
            id={id}
            aria-label={ariaLabel}
            type="range"
            min={0}
            max={count - 1}
            step={1}
            value={at}
            disabled={disabled}
            aria-valuetext={levels[at]?.label}
            aria-describedby={describedBy}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              pick(Number(event.currentTarget.value));
            }}
            {...stylex.props(levelStyles.input)}
          />
        </span>
      </div>
    </div>
  );
};

/** The scale's two ends, named under the track; a screen reader has the chosen level from the input. */
const LevelsEnds = ({
  first,
  last,
  at,
  count,
}: {
  first: string | undefined;
  last: string | undefined;
  at: number;
  count: number;
}) => (
  <div
    aria-hidden="true"
    data-slot="slider-levels-ends"
    {...stylex.props(levelStyles.ends)}
  >
    <span
      data-on={at === 0 ? "" : undefined}
      {...stylex.props(at === 0 && levelStyles.endOn)}
    >
      {first}
    </span>
    <span
      data-on={at === count - 1 ? "" : undefined}
      {...stylex.props(at === count - 1 && levelStyles.endOn)}
    >
      {last}
    </span>
  </div>
);

/** A slider's name, over its track: what it sets. */
export const SliderLabel = ({ children }: SliderLabelProps) => {
  const slider = use(LabelContext);
  if (slider === undefined) {
    throw new Error("SliderLabel must be used within a Slider.");
  }
  if (slider.variant === "default") {
    return <FieldLabel>{children}</FieldLabel>;
  }
  // No control to name (fewer than two levels): the words alone.
  const Tag = slider.id === undefined ? "span" : "label";
  return (
    <Tag
      htmlFor={slider.id}
      {...stylex.props(
        levelStyles.label,
        slider.large && levelStyles.labelDefault
      )}
    >
      {children}
    </Tag>
  );
};

/** One of a short named scale, chosen along a round track of dots. */
const LevelsSlider = ({
  levels,
  value,
  defaultValue,
  onValueChange,
  children,
  "aria-label": ariaLabel,
  top = "auto",
  size: sliderSize = "default",
  disabled = false,
  emptyText,
  style,
}: SliderLevelsProps) => {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const { at, pick } = useLevel(
    levels,
    value,
    defaultValue,
    onValueChange,
    disabled
  );
  const large = sliderSize === "default";
  // In development, say so when nothing names it: no SliderLabel, no aria-label.
  useEffect(() => {
    warnUnnamed("Slider", input.current);
  }, []);

  if (levels.length < 2) {
    // No scale to choose on: its name as ever, and the line in the room the track and its ends
    // take, so a slider whose model has one level stands as tall as any other.
    return (
      <div
        data-slot="slider"
        data-empty=""
        {...stylex.props(levelStyles.root, style)}
      >
        {ariaLabel === undefined ? (
          // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
          <LabelContext value={{ variant: "levels", id: undefined, large }}>
            {children}
          </LabelContext>
        ) : (
          <span {...stylex.props(visuallyHidden)}>{ariaLabel}</span>
        )}
        <p
          data-slot="slider-levels-empty"
          {...stylex.props(levelStyles.note, levelStyles.emptyRoom)}
        >
          {emptyText}
        </p>
      </div>
    );
  }

  const count = levels.length;
  const description = levels[at]?.description;
  return (
    <div
      data-slot="slider"
      data-level={levels[at]?.id}
      {...stylex.props(
        levelStyles.root,
        disabled && levelStyles.disabled,
        style
      )}
    >
      {ariaLabel === undefined ? (
        // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
        <LabelContext value={{ variant: "levels", id, large }}>
          {children}
        </LabelContext>
      ) : null}
      <LevelsTrack
        levels={levels}
        at={at}
        pick={pick}
        disabled={disabled}
        large={large}
        lit={topOn(top, count) && at === count - 1}
        id={id}
        ariaLabel={ariaLabel}
        input={input}
        describedBy={
          description === undefined ? undefined : `${id}-description`
        }
      />
      <LevelsEnds
        first={levels[0]?.label}
        last={levels[count - 1]?.label}
        at={at}
        count={count}
      />
      {description === undefined ? null : (
        <p id={`${id}-description`} {...stylex.props(levelStyles.note)}>
          {description}
        </p>
      )}
    </div>
  );
};

// ---- Slider ----------------------------------------------------------------------------------------

/** A number or a range along a scale; with `variant="levels"`, one of a short named scale. */
export const Slider = (props: SliderProps) =>
  props.variant === "levels" ? (
    <LevelsSlider {...props} />
  ) : (
    <DefaultSlider {...props} />
  );
