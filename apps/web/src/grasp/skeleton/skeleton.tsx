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
// `look` picks how it waits. `field`, the default (provisional, 14 November): a fine dot field,
// almost still, with a wave of our light (mint into pine) crossing it, one wave for
// the whole page (light.ts). `resolve`: the same, but the field gathers denser over the first passes,
// so a long wait reads as progress. `lines`: for text, a hairline per line and the light running
// along the lines one after another, as if being written. `grey`: the soft fill that breathes, as
// it was. With reduced motion every look is still.
//
// It is hidden from screen readers; the region it stands in carries `aria-busy` and a status
// that says what is loading. Every value is a token (src/tokens). A caller may set size and
// layout (the `style` prop): the content it stands for decides how large it is.
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";

import { grasp, media } from "../tokens/tokens.stylex";
import { lightUp, stopNothing } from "./light";

export type SkeletonShape = "line" | "block" | "circle";
export type SkeletonText = "sm" | "md" | "lg";
export type SkeletonLook = "grey" | "field" | "resolve" | "lines";

type Layout = string | number | null;

/** What a caller may style: its size and where it sits. Never its fill or its corner. */
export type SkeletonLayoutStyle = stylex.StyleXStyles<{
  width?: Layout;
  height?: Layout;
  minWidth?: Layout;
  maxWidth?: Layout;
  aspectRatio?: Layout;
  alignSelf?: Layout;
  justifySelf?: Layout;
  flexGrow?: Layout;
  flexShrink?: Layout;
  flexBasis?: Layout;
  gridArea?: Layout;
  gridColumn?: Layout;
  gridRow?: Layout;
  margin?: Layout;
  marginBlock?: Layout;
  marginBlockStart?: Layout;
  marginBlockEnd?: Layout;
  marginInline?: Layout;
  marginInlineStart?: Layout;
  marginInlineEnd?: Layout;
}>;

/** Every prop a Skeleton takes. */
export interface SkeletonProps {
  /**
   * The shape of what is loading: `line` for a line of text, `block` for an image, a chart or a
   * field, `circle` for an avatar.
   * @default "line"
   */
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
   * How it waits: `field` a dot field our light crosses; `grey` the soft fill that breathes;
   * `resolve` the field gathering denser as the wait goes on; `lines` light written along lines of
   * text (a block or circle takes the field).
   * @default "field"
   */
  look?: SkeletonLook;
  /** Its size and where it sits: the content it stands for decides. Never its fill or corner. */
  style?: SkeletonLayoutStyle;
  /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
  layout?: SkeletonLayoutStyle;
}

const breathe = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: grasp.skeletonLow },
});

const gather = stylex.keyframes({
  "0%": { opacity: 0 },
  "100%": { opacity: 1 },
});

/** The band of light's width; light.ts reads it from the band itself. */
const BAND = 420;
/** The resolving field gathers over about four passes of the light. */
const GATHER = "14s";

/** The dots: 1px on a 4px pitch, in a quiet ink. */
const DOTS = `radial-gradient(circle at center, color-mix(in oklab, ${grasp.ink} 20%, transparent) 0.7px, transparent 1px)`;
/** Where the light shows: the same pitch, a little larger, so a lit dot grows. */
const LIT = `radial-gradient(circle at center, ${grasp.ink} 1px, transparent 1.4px)`;
/** A hairline through the middle of a line of text. */
const TRACK = `linear-gradient(to bottom, transparent calc(50% - 0.5px), color-mix(in oklab, ${grasp.ink} 22%, transparent) calc(50% - 0.5px), color-mix(in oklab, ${grasp.ink} 22%, transparent) calc(50% + 0.5px), transparent calc(50% + 0.5px))`;
const LIT_TRACK = `linear-gradient(to bottom, transparent calc(50% - 1px), ${grasp.ink} calc(50% - 1px), ${grasp.ink} calc(50% + 1px), transparent calc(50% + 1px))`;

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
  // ---- The dot-field looks ----
  // No fill of its own: the field inside it draws, in the content box (a line's letters' height).
  bare: {
    backgroundColor: "transparent",
  },
  field: {
    position: "relative",
    display: "block",
    height: "100%",
    overflow: "hidden",
    borderRadius: "inherit",
    backgroundImage: { default: DOTS, [media.forced]: "none" },
    backgroundSize: "4px 4px",
    outlineWidth: { default: 0, [media.forced]: 1 },
    outlineStyle: "solid",
    outlineColor: "GrayText",
    outlineOffset: -1,
  },
  // A picture or an avatar stands on the soft ground; text does not.
  ground: {
    backgroundColor: grasp.soft,
  },
  track: {
    backgroundImage: { default: TRACK, [media.forced]: "none" },
    backgroundSize: "auto",
  },
  // The resolving look: a second grid between the first, gathering over the first passes.
  dense: {
    position: "absolute",
    inset: 0,
    backgroundImage: DOTS,
    backgroundSize: "4px 4px",
    backgroundPosition: "2px 2px",
    opacity: { default: 1, [media.reduced]: 0 },
    animationName: { default: gather, [media.reduced]: "none" },
    animationDuration: GATHER,
    animationTimingFunction: "steps(4, jump-end)",
    animationFillMode: "both",
  },
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
  },
  litTrack: {
    maskImage: LIT_TRACK,
    maskSize: "auto",
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

export const Skeleton = ({
  shape = "line",
  text = "sm",
  pulse = true,
  look = "field",
  style,
  layout,
}: SkeletonProps) => {
  const field = useRef<HTMLSpanElement>(null);
  const band = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = field.current;
    const light = band.current;
    if (look === "grey" || element === null || light === null) {
      return stopNothing;
    }
    return lightUp(element, light, look);
  }, [look]);

  if (look === "grey") {
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
  const lines = look === "lines" && shape === "line";
  return (
    <span
      aria-hidden="true"
      data-slot="skeleton"
      data-shape={shape}
      data-look={look}
      {...stylex.props(
        styles.skeleton,
        styles[shape],
        shape === "line" && styles[text],
        styles.bare,
        layout ?? style
      )}
    >
      <span
        ref={field}
        {...stylex.props(
          styles.field,
          shape !== "line" && styles.ground,
          lines && styles.track
        )}
      >
        {look === "resolve" ? <span {...stylex.props(styles.dense)} /> : null}
        <span {...stylex.props(styles.lit, lines && styles.litTrack)}>
          <span ref={band} {...stylex.props(styles.band)} />
        </span>
      </span>
    </span>
  );
};
