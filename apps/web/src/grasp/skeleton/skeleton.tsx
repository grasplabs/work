// Skeleton: a placeholder in the shape of content that is still loading, from shadcn's
// (registry/bases/base/ui/skeleton.tsx), converted from Tailwind to StyleX and made Grasp's after
// Palermo: a soft grey fill with no edge that breathes, slowly, until the content arrives. It
// takes the shape of what it stands for: a line of text, a block, or a circle.
//
//   <Skeleton />                                   one line of small text
//   <Skeleton text="lg" />                         one line of a lead or a card title
//   <Skeleton shape="block" style={size.chart} />  a block, sized by the layout
//   <Skeleton shape="circle" />                    an avatar
//
// `look` picks how it waits. `field`, the default: a fine dot field, almost still, with a wave of
// our light (mint into pine) crossing it, one wave for the whole page (light.ts). `grey`: the soft
// fill, which a still Skeleton (`pulse={false}`, for a long list) keeps. With reduced motion every
// look is still.
//
// It is hidden from screen readers; the region it stands in carries `aria-busy` and a status
// that says what is loading. Every value is a token (src/tokens). A caller may set size and
// layout (the `style` prop): the content it stands for decides how large it is.
/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";
import { lightUp, stopNothing } from "./light";

export type SkeletonShape = "line" | "block" | "circle";
export type SkeletonText = "sm" | "md" | "lg";
export type SkeletonLook = "grey" | "field";

/** What a caller may style: its size and where it sits. Never its fill or its corner. */
export type SkeletonLayoutStyle = LayoutStyle;

/** Every prop a Skeleton takes. */
export interface SkeletonProps {
  /**
   * The shape of what is loading: `line` for a line of text, `block` for an image, a chart or a
   * field, `circle` for an avatar.
   * @default "line"
   */
  variant?: SkeletonShape;
  /** @deprecated Use `variant`. */
  shape?: SkeletonShape;
  /**
   * For a line, the text it stands for: `sm` small text, `md` body text, `lg` a lead or a card
   * title. The line is as tall as that text's line and draws only its letters' height, so
   * nothing moves when the words arrive.
   * @default "sm"
   */
  text?: SkeletonText;
  /**
   * Breathes while it waits. Turn it off in a long list, where many breathing at once is noise.
   * @default true
   */
  pulse?: boolean;
  /**
   * How it waits: `field` a dot field our light crosses; `grey` the soft fill that breathes.
   * @default "field", or "grey" when `pulse` is false
   */
  surface?: SkeletonLook;
  /** @deprecated Use `surface`. */
  look?: SkeletonLook;
  /** @deprecated Use `layout`. */
  style?: SkeletonLayoutStyle;
  /** Its size and where it sits: the content it stands for decides. Never its fill or corner. */
  layout?: SkeletonLayoutStyle;
}

const breathe = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: grasp.skeletonLow },
});

/** The band of light's width; light.ts reads it from the band itself. */
const BAND = 420;

/** The dots: 1px on a 4px pitch, in a quiet ink. */
const DOTS = `radial-gradient(circle at center, color-mix(in oklab, ${grasp.ink} 20%, transparent) 0.7px, transparent 1px)`;
/** Where the light shows: the same pitch, a little larger, so a lit dot grows. */
const LIT = `radial-gradient(circle at center, ${grasp.ink} 1px, transparent 1.4px)`;

const styles = stylex.create({
  skeleton: {
    display: "block",
    boxSizing: "border-box",
    minWidth: 0,
    maxWidth: "100%",
    backgroundColor: {
      default: grasp.skeletonFill,
      [media.forced]: "GrayText",
    },
    cursor: "progress",
  },
  pulse: {
    animationName: { default: breathe, [media.reduced]: "none" },
    animationDuration: grasp.skeletonPulse,
    animationTimingFunction: grasp.skeletonEase,
    animationIterationCount: "infinite",
  },
  // A line of text: the height of the text's line, with the fill only on the letters' height in
  // the middle (background-clip), so stacked lines and the real words take the same room. It
  // gives way in a row beside other parts.
  line: {
    width: "100%",
    flexShrink: 1,
    backgroundClip: "content-box",
    borderRadius: grasp.cornerMark,
    cornerShape: grasp.cornerShape,
  },
  sm: {
    height: grasp.textSmLine,
    paddingBlock: `calc((${grasp.textSmLine} - ${grasp.textSm}) / 2)`,
  },
  md: {
    height: grasp.textMdLine,
    paddingBlock: `calc((${grasp.textMdLine} - ${grasp.textMd}) / 2)`,
  },
  lg: {
    height: grasp.textLgLine,
    paddingBlock: `calc((${grasp.textLgLine} - ${grasp.textLg}) / 2)`,
  },
  // A block: as tall as a default control unless the layout says otherwise, with the one corner
  // (the browser caps it at half the height, so a low block gets round ends).
  block: {
    width: "100%",
    flexShrink: 1,
    height: grasp.controlMd,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
  },
  // An avatar: a circle as large as a default control. It keeps its size in a row.
  circle: {
    flexShrink: 0,
    width: grasp.controlMd,
    height: grasp.controlMd,
    borderRadius: grasp.cornerCircle,
  },
  // ---- The dot field ----
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
    // Square: a line's dots are its shape, and a rounded corner would cut the dots at its ends.
    borderRadius: 0,
    backgroundImage: { default: DOTS, [media.forced]: "none" },
    backgroundSize: "4px 4px",
    // Only whole dots: as many as fit, the room left over shared out between them, so no row of
    // half dots is cut at a line's foot (a 14px line held three and a half rows).
    backgroundRepeat: "space",
    outlineWidth: { default: 0, [media.forced]: 1 },
    outlineStyle: "solid",
    outlineColor: "GrayText",
    outlineOffset: -1,
  },
  // A picture or an avatar stands on the soft ground; text does not. The ground is the outer
  // shape's, with its corner; the dots stand space-1 inside it, where no corner reaches them.
  groundOuter: {
    backgroundColor: grasp.soft,
  },
  ground: {
    padding: grasp.space1,
    backgroundOrigin: "content-box",
    backgroundClip: "content-box",
  },
  litInset: { inset: grasp.space1 },
  // A circle's dots keep to the square inside it, clear of its curve: from a space-1 inset the
  // square grid's corner dots stood on the rim.
  groundCircle: { padding: grasp.space2 },
  litCircle: { inset: grasp.space2 },
  // Where the light can show: the dots, a little larger.
  lit: {
    position: "absolute",
    inset: 0,
    display: {
      default: "block",
      [media.forced]: "none",
      [media.reduced]: "none",
    },
    maskImage: LIT,
    maskSize: "4px 4px",
    // As the dots: whole ones, laid out as theirs, so a lit dot stands on its dot.
    maskRepeat: "space",
  },
  // The light: a soft band of mint into pine, slanted, moved by light.ts.
  band: {
    position: "absolute",
    insetBlock: 0,
    // Physical: light.ts moves it in pixels from the left edge, either way round.
    left: 0,
    width: BAND,
    backgroundImage: `linear-gradient(105deg, transparent 0%, color-mix(in oklab, ${grasp.mint} 70%, transparent) 30%, ${grasp.mint} 48%, color-mix(in oklab, ${grasp.pine} 80%, transparent) 66%, transparent 100%)`,
    transform: `translateX(-${BAND}px)`,
    willChange: "transform",
  },
});

/**
 * The dot field inside a Skeleton, and the light that crosses it. A line's dots are its shape; a
 * block's or a circle's stand inside its ground.
 */
const Field = ({
  shape,
  field,
  band,
}: {
  shape: SkeletonShape;
  field: RefObject<HTMLSpanElement | null>;
  band: RefObject<HTMLSpanElement | null>;
}) => {
  const grounded = shape !== "line";
  const round = shape === "circle";
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
        <span ref={band} {...stylex.props(styles.band)} />
      </span>
    </span>
  );
};

export const Skeleton = ({
  shape: shapeDeprecated,
  variant: shape = shapeDeprecated ?? "line",
  text = "sm",
  pulse = true,
  look: lookDeprecated,
  surface: look = lookDeprecated,
  style,
  layout,
}: SkeletonProps) => {
  // A still Skeleton (`pulse={false}`, for a long list) stays the still grey unless a look is asked for.
  const drawn: SkeletonLook = look ?? (pulse ? "field" : "grey");
  const field = useRef<HTMLSpanElement>(null);
  const band = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = field.current;
    const light = band.current;
    if (drawn === "grey" || element === null || light === null) {
      return stopNothing;
    }
    return lightUp(element, light);
  }, [drawn]);

  if (drawn === "grey") {
    return (
      <span
        aria-hidden="true"
        data-slot="skeleton"
        data-shape={shape}
        {...stylex.props(
          styles.skeleton,
          styles[shape],
          shape === "line" && styles[text],
          pulse && styles.pulse,
          layout ?? style
        )}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      data-slot="skeleton"
      data-shape={shape}
      data-look={drawn}
      {...stylex.props(
        styles.skeleton,
        styles[shape],
        shape === "line" && styles[text],
        styles.bare,
        shape !== "line" && styles.groundOuter,
        layout ?? style
      )}
    >
      <Field shape={shape} field={field} band={band} />
    </span>
  );
};
