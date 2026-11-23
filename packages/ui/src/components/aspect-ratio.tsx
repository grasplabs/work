// AspectRatio: a box that keeps its width to its height, in StyleX. It holds the room of
// an image, a video or a map before it loads, so nothing below it moves when it does.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <AspectRatio ratio={16 / 9}><img src={cover} alt="The team at the summit" /></AspectRatio>
//
// It draws nothing of its own. What it holds fills it at width and height 100% (an image or a
// video with object-fit: cover), cut to the one corner. A caller sets its width and where it sits
// (the `style` prop); the ratio sets its height.
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { radius } from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";

/** Every prop an AspectRatio takes. */
export interface AspectRatioProps {
  /** What it holds: an image, a video, a map, at width and height 100% to fill the box. */
  children: ReactNode;
  /**
   * Width over height: `16 / 9` for a video, `1` for a square, `4 / 3` for a photo.
   * @default 1
   */
  ratio?: number;
  /**
   * Cut to the one corner, as a picture on a card. Off when it sits flush in a frame of its own.
   * @default true
   */
  rounded?: boolean;
  /** Its width and where it sits. The ratio sets its height. */
  style?: LayoutStyle;
}

const styles = stylex.create({
  box: (ratio: number) => ({
    position: "relative",
    width: "100%",
    aspectRatio: ratio,
    overflow: "hidden",
  }),
  rounded: {
    borderRadius: radius.base,
    cornerShape: radius.shape,
  },
});

/** A box that keeps its width to its height. */
export const AspectRatio = ({
  children,
  ratio = 1,
  rounded = true,
  style,
}: AspectRatioProps) => (
  <div
    data-slot="aspect-ratio"
    {...stylex.props(styles.box(ratio), rounded && styles.rounded, style)}
  >
    {children}
  </div>
);
