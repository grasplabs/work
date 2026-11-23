// AspectRatio: a box that keeps one shape, width to height, whatever its width: a picture, a
// drawing or a video fills it. Work's stand-in for Damsko's AspectRatio, which can't be installed
// at a pinned tag yet (WORK-33, logged in handoffs/library-changes.md): the same name and props, so
// the swap is only an import.
//
//   <AspectRatio ratio={16 / 10}><img src={still} alt="" /></AspectRatio>
//
// The ratio sets the height; a caller sets only its width and where it sits (the `style` prop).
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import type { LayoutStyle } from "../layout/layout";

/** Every prop an AspectRatio takes. */
export interface AspectRatioProps {
  /**
   * Its shape, width over height (`16 / 10`).
   * @default 1
   */
  ratio?: number;
  /** What fills it: a picture, a drawing or a video. */
  children: ReactNode;
  /** Layout only: its width and where it sits. */
  style?: LayoutStyle;
}

const styles = stylex.create({
  box: (ratio: number) => ({
    position: "relative",
    display: "block",
    width: "100%",
    aspectRatio: ratio,
    overflow: "hidden",
  }),
  fill: {
    position: "absolute",
    inset: 0,
    display: "grid",
  },
});

/** A box of one shape, `ratio` wide to 1 tall, that its children fill. */
export const AspectRatio = ({
  ratio = 1,
  children,
  style,
}: AspectRatioProps) => (
  <span data-slot="aspect-ratio" {...stylex.props(styles.box(ratio), style)}>
    <span {...stylex.props(styles.fill)}>{children}</span>
  </span>
);
