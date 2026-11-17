// Layout: the one set of properties a caller may give any part, by its `layout` prop (or `style`,
// the same). Where the part sits and how much room it takes: never its look, its colours, its
// corners or its inner spacing, which belong to the part. Every part takes exactly this set, so
// what works on one works on all (row 54): hiding a phone-only picker on wide screens is
// `display: { default: null, "@media (min-width: 48rem)": "none" }` on a Select as on a Button.
import type * as stylex from "@stylexjs/stylex";

type Value = string | number | null;

/** What a caller may style on any part: where it sits and how much room it takes. */
export type LayoutStyle = stylex.StyleXStyles<{
  // Whether it shows, as a box: `none` to leave it out at some widths.
  display?: Value;
  // Its place in the row or grid around it.
  alignSelf?: Value;
  justifySelf?: Value;
  gridArea?: Value;
  gridColumn?: Value;
  gridRow?: Value;
  order?: Value;
  flexGrow?: Value;
  flexShrink?: Value;
  flexBasis?: Value;
  // The room around it.
  margin?: Value;
  marginBlock?: Value;
  marginBlockStart?: Value;
  marginBlockEnd?: Value;
  marginInline?: Value;
  marginInlineStart?: Value;
  marginInlineEnd?: Value;
  // How much room it takes, from the layout around it.
  width?: Value;
  minWidth?: Value;
  maxWidth?: Value;
  height?: Value;
  minHeight?: Value;
  maxHeight?: Value;
  aspectRatio?: Value;
  // Held in place while the page scrolls past it (a sticky bar), or laid over its neighbours.
  position?: Value;
  inset?: Value;
  insetBlock?: Value;
  insetBlockStart?: Value;
  insetBlockEnd?: Value;
  insetInline?: Value;
  insetInlineStart?: Value;
  insetInlineEnd?: Value;
  zIndex?: Value;
}>;

/** The layout a part was given: `layout`, else `style`, its first name. One place for the choice. */
export const layoutOf = (
  layout: LayoutStyle | undefined,
  style: LayoutStyle | undefined
) => layout ?? style;
