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
// It is hidden from screen readers; the region it stands in carries `aria-busy` and a status
// that says what is loading. Every value is a token (src/tokens). A caller may set size and
// layout (the `style` prop): the content it stands for decides how large it is.
import * as stylex from "@stylexjs/stylex";

import { grasp, media } from "../tokens/tokens.stylex";

export type SkeletonShape = "line" | "block" | "circle";
export type SkeletonText = "sm" | "md" | "lg";

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
  /** Its size and where it sits: the content it stands for decides. Never its fill or corner. */
  style?: SkeletonLayoutStyle;
  /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
  layout?: SkeletonLayoutStyle;
}

const breathe = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: grasp.skeletonLow },
});

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
});

export const Skeleton = ({
  shape = "line",
  text = "sm",
  pulse = true,
  style,
  layout,
}: SkeletonProps) => (
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
