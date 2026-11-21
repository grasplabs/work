// Separator: a hairline between groups of content, from shadcn's (registry/bases/base/ui/separator.tsx,
// on Base UI), converted from Tailwind to StyleX and rebuilt on UI SDK's Separator, which says it
// to a screen reader as a separator, or not at all when it is only a line. After Palermo: one soft
// 1px line, the page's own hairline colour, with no margin of its own.
//
//   <Separator />
//   <Separator orientation="vertical" />
//   <Separator decorative />                       only a line: the words around it already divide
//
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop): the room
// around the line belongs to the layout it sits in.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { Separator as SeparatorPrimitive } from "@ui-sdk/react/separator";

import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";

export type SeparatorOrientation = "horizontal" | "vertical";

/** What a caller may style: the room around the line and where it sits. Never its look. */
export type SeparatorLayoutStyle = LayoutStyle;

/** Every prop a Separator takes. */
export interface SeparatorProps {
  /**
   * Which way the line runs: `horizontal` between stacked groups, `vertical` between items in a
   * row, where it takes the row's height.
   * @default "horizontal"
   */
  orientation?: SeparatorOrientation;
  /**
   * Only a line: a screen reader skips it. Use it when the words around it already say the groups
   * are apart, such as "or" between two ways to sign in.
   * @default false
   */
  decorative?: boolean;
  /** @deprecated Use `layout`. */
  style?: SeparatorLayoutStyle;
  /**
   * Layout only: the room around the line, and where it sits. In a row beside words, give a
   * horizontal line `flexGrow: 1`, `flexBasis: 0` and `alignSelf: "center"`, so it takes the
   * room the words leave, through their middle.
   */
  layout?: SeparatorLayoutStyle;
}

const styles = stylex.create({
  line: {
    flexShrink: 0,
    margin: 0,
    borderWidth: 0,
    backgroundColor: { default: grasp.line, [media.forced]: "CanvasText" },
  },
  // As wide as its box, less any margin a caller gives it: stretched, never a fixed 100%.
  horizontal: {
    alignSelf: "stretch",
    justifySelf: "stretch",
    height: grasp.separatorWidth,
  },
  vertical: {
    width: grasp.separatorWidth,
    alignSelf: "stretch",
  },
});

export const Separator = ({
  orientation = "horizontal",
  decorative = false,
  style,
  layout,
}: SeparatorProps) => (
  <SeparatorPrimitive
    orientation={orientation}
    decorative={decorative}
    {...stylex.props(styles.line, styles[orientation], layout ?? style)}
  />
);
