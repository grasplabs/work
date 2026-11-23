// Separator: a hairline between groups of content,
// in StyleX, built on UI SDK's Separator, which says it
// to a screen reader as a separator, or not at all when it is only a line. One soft 1px line, the
// page's own hairline colour, with no margin of its own.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <Separator />
//   <Separator orientation="vertical" />
//   <Separator decorative />                       only a line: the words around it already divide
//
// A caller may set layout only (the `style` prop): the room around the line belongs to the layout
// it sits in.
"use client";

import * as stylex from "@stylexjs/stylex";
import { Separator as SeparatorPrimitive } from "@ui-sdk/react/separator";

import { colors, media, size } from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";

export type SeparatorOrientation = "horizontal" | "vertical";

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
  /**
   * Layout only: the room around the line, and where it sits. In a row beside words, give a
   * horizontal line `flexGrow: 1`, `flexBasis: 0` and `alignSelf: "center"`, so it takes the
   * room the words leave, through their middle.
   */
  style?: LayoutStyle;
}

const styles = stylex.create({
  line: {
    flexShrink: 0,
    margin: 0,
    borderWidth: 0,
    backgroundColor: {
      default: colors.border,
      [media.forcedColors]: "CanvasText",
    },
  },
  // As wide as its box, less any margin a caller gives it: stretched, never a fixed 100%.
  horizontal: {
    alignSelf: "stretch",
    justifySelf: "stretch",
    height: size.separatorWidth,
  },
  vertical: {
    width: size.separatorWidth,
    alignSelf: "stretch",
  },
});

export const Separator = ({
  orientation = "horizontal",
  decorative = false,
  style,
}: SeparatorProps) => (
  <SeparatorPrimitive
    orientation={orientation}
    decorative={decorative}
    {...stylex.props(
      styles.line,
      orientation === "vertical" ? styles.vertical : styles.horizontal,
      style
    )}
  />
);
