// Skeleton: a placeholder in the shape of content that is still loading, in StyleX. It takes the shape of
// what it stands for: a line of text, a rectangle, or a circle.
//
//   <Skeleton />                                       one line of small text
//   <Skeleton size="lg" />                             one line of a lead or a card title
//   <Skeleton variant="rectangular" style={chart} />   a rectangle, sized by the layout
//   <Skeleton variant="circular" />                    an avatar
//
// `animation` picks how it waits. `wave`, the default: a fine field of pixels, almost still, with a wave
// of light (mint into pine) crossing it, one wave for the whole page. `pulse`: the soft fill,
// breathing slowly. `false`: the soft fill, still, for a long list. With reduced motion every one
// is still.
//
// It is hidden from screen readers; the region it stands in carries `aria-busy` and a status that
// says what is loading. A caller may set size and layout (the `style` prop): the content it stands
// for decides how large it is.
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "../lib/tokens.stylex";
import { skeletonWave } from "../lib/tokens.values";
import type { LayoutStyle } from "../lib/utils";

export type SkeletonVariant = "text" | "rectangular" | "circular";
export type SkeletonSize = "sm" | "default" | "lg";

/** Every prop a Skeleton takes. */
export interface SkeletonProps {
  /**
   * The shape of what is loading: `text` for a line of text, `rectangular` for an image, a chart
   * or a field, `circular` for an avatar.
   * @default "text"
   */
  variant?: SkeletonVariant;
  /**
   * For a line of text, the text it stands for: `sm` small text, `default` body text, `lg` a lead
   * or a card title. The line is as tall as that text's line and draws only its letters' height,
   * so nothing moves when the words arrive.
   * @default "sm"
   */
  size?: SkeletonSize;
  /**
   * How it waits: `wave` a field of pixels a wave of light crosses; `pulse` the soft fill, breathing;
   * `false` the soft fill, still, for a long list, where many breathing at once is noise.
   * @default "wave"
   */
  animation?: "pulse" | "wave" | false;
  /** Its size and where it sits: the content it stands for decides. Never its fill or corner. */
  style?: LayoutStyle;
}

// ---- The light ------------------------------------------------------------------------------
//
// The light that crosses a `wave` Skeleton. One clock for the whole page: every placeholder's band
// runs on the document timeline from its origin, offset by where the placeholder stands, so a wave
// passes across a table or a grid of cards as one field behind many windows rather than each cell
// blinking alone. The wave repeats every screen's height down the page, so a placeholder far down a
// long list is lit as well. Transform only.
//
// It is measured when the placeholder comes into view and again when the window or the page changes
// size, so it stays in step when content above it loads, after a hidden panel opens, or after a
// resize. It pauses while the placeholder is off screen, never runs with reduced motion or in forced
// colours (and follows either if it changes while the page is open), and runs the other way right
// to left. The component only starts and stops it from an effect.

/** What a light that never started stops. */
const stopNothing = () => {
  // No light was started: nothing to stop.
};

/** The keyframes and length of one pass, for a placeholder where it stands now; null if unseen. */
const passFor = (field: HTMLElement, band: HTMLElement) => {
  const rect = field.getBoundingClientRect();
  const width = band.offsetWidth;
  if (rect.width === 0 || rect.height === 0 || width === 0) {
    return null;
  }
  const page = document.documentElement.clientWidth;
  const screen = window.innerHeight;
  const rtl = getComputedStyle(field).direction === "rtl";
  // Where the placeholder stands, from the edge the wave starts at; down the page the wave repeats
  // every screen's height, so it reaches everything.
  const fromStart = rtl
    ? page - rect.right - window.scrollX
    : rect.left + window.scrollX;
  const down = ((rect.top + window.scrollY) % screen) * skeletonWave.slope;
  const offset = fromStart + down;
  // The wave's path: across the page and down one screen, the same for every placeholder.
  const sweep = page + screen * skeletonWave.slope + width;
  const from = -width - offset;
  const to = sweep - width - offset;
  const at = (start: number) => (rtl ? rect.width - width - start : start);
  return {
    frames: [
      { transform: `translateX(${at(from)}px)` },
      { transform: `translateX(${at(to)}px)`, offset: 1 - skeletonWave.rest },
      { transform: `translateX(${at(to)}px)` },
    ],
    duration: (sweep / skeletonWave.speed / (1 - skeletonWave.rest)) * 1000,
  };
};

/** One placeholder's light: its field, its band, whether it is in view, and its motion. */
interface Light {
  field: HTMLElement;
  band: HTMLElement;
  seen: boolean;
  motion: Animation | null;
}

// Every placeholder on the page shares one set of watchers, made with the first and taken down
// with the last: one IntersectionObserver for all of them, and one each of the page's
// ResizeObserver, the window's resize and the two media queries, so a list of 200 placeholders adds
// 200 entries, not 1,000 watchers.
const lights = new Map<Element, Light>();
let watchers: {
  still: MediaQueryList;
  forced: MediaQueryList;
  stop: () => void;
} | null = null;

/**
 * Measures the given placeholders afresh and starts each on the page's clock, so every one is in
 * step. Every measure first, then every start: the page's style and layout are worked out once for
 * all of them, not once for each.
 */
const relight = (all: Iterable<Light>) => {
  const quiet =
    watchers === null || watchers.still.matches || watchers.forced.matches;
  const each = [...all];
  const passes = each.map((light) =>
    quiet || !light.seen ? null : passFor(light.field, light.band)
  );
  for (const [index, light] of each.entries()) {
    light.motion?.cancel();
    light.motion = null;
    const pass = passes[index];
    if (pass !== null && pass !== undefined) {
      light.motion = light.band.animate(pass.frames, {
        duration: pass.duration,
        iterations: Number.POSITIVE_INFINITY,
        easing: "linear",
      });
      light.motion.startTime = 0;
    }
  }
};

/** Whether it is in view, by the last word on each placeholder: a quick exit and return come in one batch. */
const onView = (entries: IntersectionObserverEntry[]) => {
  const last = new Map<Element, boolean>();
  for (const entry of entries) {
    last.set(entry.target, entry.isIntersecting);
  }
  const shown: Light[] = [];
  for (const [target, seen] of last) {
    const light = lights.get(target);
    if (light !== undefined) {
      light.seen = seen;
      if (seen) {
        shown.push(light);
      } else {
        light.motion?.pause();
      }
    }
  }
  relight(shown);
};

let view: IntersectionObserver | null = null;

/** Makes the shared watchers, for the first placeholder. */
const watch = () => {
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  const forced = window.matchMedia("(forced-colors: active)");
  const all = () => {
    relight(lights.values());
  };
  view = new IntersectionObserver(onView);
  // Content arriving above moves them down the page: measure again when the page changes size.
  const page =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(all);
  page?.observe(document.body);
  window.addEventListener("resize", all);
  still.addEventListener("change", all);
  forced.addEventListener("change", all);
  return {
    still,
    forced,
    stop: () => {
      view?.disconnect();
      view = null;
      page?.disconnect();
      window.removeEventListener("resize", all);
      still.removeEventListener("change", all);
      forced.removeEventListener("change", all);
    },
  };
};

/** Starts the light in one placeholder; returns what stops it. */
const lightUp = (field: HTMLElement, band: HTMLElement): (() => void) => {
  if (typeof window === "undefined" || typeof band.animate !== "function") {
    return stopNothing;
  }
  watchers ??= watch();
  const light: Light = { field, band, seen: false, motion: null };
  lights.set(field, light);
  view?.observe(field);
  return () => {
    view?.unobserve(field);
    lights.delete(field);
    light.motion?.cancel();
    if (lights.size === 0) {
      watchers?.stop();
      watchers = null;
    }
  };
};

// ---- The placeholder ------------------------------------------------------------------------

const breathe = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: size.skeletonLow },
});

// ---- Where the field's pixels stand ----
//
// A pixel is a 2px square, as wide as the dot it is drawn for, and stands one in every 4px. As many
// whole 4px tiles as fit stand along each side of the field, the first against one edge and the last
// against the other, and the room left over is shared out between them: a 14px line holds three
// rows, 1px clear above and below, and a circle's five by five stand in its middle. The room left
// over is under a tile, so it is shared out in whole pixels, at up to three places a quarter, a half
// and three quarters along: a square on part of a pixel is a smear, which is what sharing it out
// evenly between every pair (`background-repeat: space`) draws.
//
// So a side is four runs of tiles, each a layer of its own that repeats inside its run and nowhere
// else. The rows are the field's background and the columns its mask: where they cross is a pixel.
// The sides are read from the field itself (`cqw`, `cqh`). Where a browser lacks the maths the
// pixels stand in every 4px from the corner.

// Along a side of `side`: the whole tiles that fit, and the pixels left over (none to three).
const tiles = (side: string) => `round(down, ${side}, 4px)`;
const over = (side: string) => `round(down, mod(${side}, 4px), 1px)`;
// Of the pixels left over: one at the half when odd, one at each quarter from two.
const quarter = (side: string) => `round(down, ${over(side)} / 2, 1px)`;
const half = (side: string) => `mod(${over(side)}, 2px)`;
// Where a run ends: after whole tiles, never before the first nor after the last but one.
const end = (side: string) => `(${tiles(side)} - 4px)`;
const first = (side: string) => `max(4px, round(down, ${side} / 4, 4px))`;
const second = (side: string) =>
  `clamp(4px, round(down, ${side} / 2, 4px), ${end(side)})`;
const third = (side: string) =>
  `min(round(down, ${side} * 3 / 4, 4px), ${end(side)})`;
// How long each of the four runs is, and where it starts: a pixel stands in the middle of its
// tile, 1px in.
const run1 = (side: string) => first(side);
const run2 = (side: string) => `calc(${second(side)} - ${first(side)})`;
const run3 = (side: string) => `calc(${third(side)} - ${second(side)})`;
const run4 = (side: string) => `calc(${tiles(side)} - ${third(side)})`;
const start2 = (side: string) =>
  `calc(${first(side)} + ${quarter(side)} + 1px)`;
const start3 = (side: string) =>
  `calc(${second(side)} + ${quarter(side)} + ${half(side)} + 1px)`;
const start4 = (side: string) => `calc(${third(side)} + ${over(side)} + 1px)`;
const ACROSS = "100cqw";
const DOWN = "100cqh";

/** A run's rows, and its columns: a 2px line in every 4px. */
const rowsIn = (colour: string) =>
  `repeating-linear-gradient(${colour} 0 2px, transparent 0 4px)`;
const COLUMNS =
  "repeating-linear-gradient(90deg, #000 0 2px, transparent 0 4px)";
const four = (layer: string) => `${layer}, ${layer}, ${layer}, ${layer}`;
const REST = `color-mix(in oklab, ${colors.foreground} 20%, transparent)`;
const ROW_SIZES = `100% ${run1(DOWN)}, 100% ${run2(DOWN)}, 100% ${run3(DOWN)}, 100% ${run4(DOWN)}`;
const ROW_STARTS = `0 1px, 0 ${start2(DOWN)}, 0 ${start3(DOWN)}, 0 ${start4(DOWN)}`;
const COLUMN_SIZES = `${run1(ACROSS)} 100%, ${run2(ACROSS)} 100%, ${run3(ACROSS)} 100%, ${run4(ACROSS)} 100%`;
const COLUMN_STARTS = `1px 0, ${start2(ACROSS)} 0, ${start3(ACROSS)} 0, ${start4(ACROSS)} 0`;

const styles = stylex.create({
  skeleton: {
    display: "block",
    boxSizing: "border-box",
    minWidth: 0,
    maxWidth: "100%",
    backgroundColor: {
      default: colors.skeletonBg,
      [media.forcedColors]: "GrayText",
    },
    cursor: "progress",
  },
  pulse: {
    animationName: { default: breathe, [media.reducedMotion]: "none" },
    animationDuration: size.skeletonPulse,
    animationTimingFunction: duration.skeletonEase,
    animationIterationCount: "infinite",
  },
  // A line of text: the height of the text's line, with the fill only on the letters' height in
  // the middle (background-clip), so stacked lines and the real words take the same room. It
  // gives way in a row beside other parts.
  text: {
    width: "100%",
    flexShrink: 1,
    backgroundClip: "content-box",
    borderRadius: radius.sm,
    cornerShape: radius.shape,
  },
  sm: {
    height: font.textSmLine,
    paddingBlock: `calc((${font.textSmLine} - ${font.textSm}) / 2)`,
  },
  default: {
    height: font.textBaseLine,
    paddingBlock: `calc((${font.textBaseLine} - ${font.textBase}) / 2)`,
  },
  lg: {
    height: font.textLgLine,
    paddingBlock: `calc((${font.textLgLine} - ${font.textLg}) / 2)`,
  },
  // A rectangle: as tall as a default control unless the layout says otherwise, with the one
  // corner (the browser caps it at half the height, so a low one gets round ends).
  rectangular: {
    width: "100%",
    flexShrink: 1,
    height: size.controlDefault,
    borderRadius: radius.xl,
    cornerShape: radius.shape,
  },
  // An avatar: a circle as large as a default control. It keeps its size in a row.
  circular: {
    flexShrink: 0,
    width: size.controlDefault,
    height: size.controlDefault,
    borderRadius: radius.circle,
  },
  // ---- The pixel field ----
  // No fill of its own: the field inside it draws, in the content box (a line's letters' height).
  bare: {
    backgroundColor: "transparent",
  },
  field: {
    position: "relative",
    display: "block",
    boxSizing: "border-box",
    height: "100%",
    overflow: "hidden",
    // Square: a line's pixels are its shape, and a rounded corner would cut them at its ends.
    borderRadius: 0,
    // What its pixels are placed by: its own content box.
    containerType: "size",
    // The pixels at rest, in a quiet foreground, in the content box.
    "::before": {
      content: '""',
      position: "absolute",
      inset: 0,
      backgroundImage: {
        default: four(rowsIn(REST)),
        [media.forcedColors]: "none",
      },
      backgroundSize: ROW_SIZES,
      backgroundPosition: ROW_STARTS,
      backgroundRepeat: "no-repeat",
      maskImage: four(COLUMNS),
      maskSize: COLUMN_SIZES,
      maskPosition: COLUMN_STARTS,
      maskRepeat: "no-repeat",
    },
    outlineWidth: { default: 0, [media.forcedColors]: 1 },
    outlineStyle: "solid",
    outlineColor: "GrayText",
    outlineOffset: -1,
  },
  // A picture or an avatar stands on the soft ground; text does not. The ground is the outer
  // shape's, with its corner; the pixels stand space-1 inside it, where no corner reaches them.
  groundOuter: {
    backgroundColor: colors.muted,
  },
  ground: {
    padding: space["1"],
    "::before": { inset: space["1"] },
  },
  litInset: { inset: space["1"] },
  // A circle's pixels keep to the square inside it, clear of its curve: from a space-1 inset the
  // square grid's corner pixels stood on the rim.
  groundCircle: {
    padding: space["2"],
    "::before": { inset: space["2"] },
  },
  litCircle: { inset: space["2"] },
  // Where the light can show: the same pixels, so a lit one is its pixel at rest in the light's
  // colour. Its columns here, its rows on the box inside.
  lit: {
    position: "absolute",
    inset: 0,
    display: {
      default: "block",
      [media.forcedColors]: "none",
      [media.reducedMotion]: "none",
    },
    maskImage: four(COLUMNS),
    maskSize: COLUMN_SIZES,
    maskPosition: COLUMN_STARTS,
    maskRepeat: "no-repeat",
  },
  litRows: {
    position: "absolute",
    inset: 0,
    maskImage: four(rowsIn("#000")),
    maskSize: ROW_SIZES,
    maskPosition: ROW_STARTS,
    maskRepeat: "no-repeat",
  },
  // The light: a soft band of mint into pine, slanted, moved by lightUp.
  band: {
    position: "absolute",
    insetBlock: 0,
    // Physical: lightUp moves it in pixels from the left edge, either way round.
    left: 0,
    width: size.skeletonBand,
    backgroundImage: `linear-gradient(105deg, transparent 0%, color-mix(in oklab, ${colors.mint} 70%, transparent) 30%, ${colors.mint} 48%, color-mix(in oklab, ${colors.pine} 80%, transparent) 66%, transparent 100%)`,
    transform: `translateX(calc(-1 * ${size.skeletonBand}))`,
    willChange: "transform",
  },
});

const shapes = {
  text: styles.text,
  rectangular: styles.rectangular,
  circular: styles.circular,
};
const lines = { sm: styles.sm, default: styles.default, lg: styles.lg };

/**
 * The pixel field inside a Skeleton, and the light that crosses it. A line's pixels are its shape; a
 * rectangle's or a circle's stand inside its ground.
 */
const Field = ({
  variant,
  field,
  band,
}: {
  variant: SkeletonVariant;
  field: RefObject<HTMLSpanElement | null>;
  band: RefObject<HTMLSpanElement | null>;
}) => {
  const grounded = variant !== "text";
  const round = variant === "circular";
  return (
    <span
      ref={field}
      {...stylex.props(
        styles.field,
        grounded && styles.ground,
        round && styles.groundCircle
      )}
    >
      <span
        {...stylex.props(
          styles.lit,
          grounded && styles.litInset,
          round && styles.litCircle
        )}
      >
        <span {...stylex.props(styles.litRows)}>
          <span ref={band} {...stylex.props(styles.band)} />
        </span>
      </span>
    </span>
  );
};

export const Skeleton = ({
  variant = "text",
  size: sized = "sm",
  animation = "wave",
  style,
}: SkeletonProps) => {
  const wave = animation === "wave";
  const field = useRef<HTMLSpanElement>(null);
  const band = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = field.current;
    const light = band.current;
    if (!wave || element === null || light === null) {
      return stopNothing;
    }
    return lightUp(element, light);
  }, [wave]);

  if (!wave) {
    return (
      <span
        aria-hidden="true"
        data-slot="skeleton"
        data-variant={variant}
        {...stylex.props(
          styles.skeleton,
          shapes[variant],
          variant === "text" && lines[sized],
          animation === "pulse" && styles.pulse,
          style
        )}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      data-slot="skeleton"
      data-variant={variant}
      data-animation="wave"
      {...stylex.props(
        styles.skeleton,
        shapes[variant],
        variant === "text" && lines[sized],
        styles.bare,
        variant !== "text" && styles.groundOuter,
        style
      )}
    >
      <Field variant={variant} field={field} band={band} />
    </span>
  );
};
