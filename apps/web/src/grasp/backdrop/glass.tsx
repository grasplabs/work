// BackdropGlass: a surface for what stands on a backdrop and needs a ground of its own, such as a
// row of suggestions: the card's colour most of the way, over a blur of the backdrop behind it,
// inside a hairline. The Composer has the same glass built in (`surface="glass"`).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { grasp, media } from "../tokens/tokens.stylex";
import type { BackdropLayoutStyle } from "./backdrop";

/** Every prop a BackdropGlass takes. */
export interface BackdropGlassProps {
  /** What stands on the glass. */
  children?: ReactNode;
  /** @deprecated Use `layout`. */
  style?: BackdropLayoutStyle;
  /** Layout only: where it sits, its size and how what stands on it is laid out. */
  layout?: BackdropLayoutStyle;
}

const styles = stylex.create({
  glass: {
    boxSizing: "border-box",
    borderWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: { default: grasp.shellRule, [media.forced]: "CanvasText" },
    borderRadius: grasp.backdropGlassCorner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.backdropGlass,
    backdropFilter: grasp.backdropGlassBlur,
    color: grasp.ink,
  },
});

/** Glass over a backdrop: a ground for what stands on it. */
export const BackdropGlass = ({
  children,
  style: styleProp,
  layout,
}: BackdropGlassProps) => (
  <div
    data-slot="backdrop-glass"
    {...stylex.props(styles.glass, layout ?? styleProp)}
  >
    {children}
  </div>
);
