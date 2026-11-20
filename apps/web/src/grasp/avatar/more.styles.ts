// The "+N" that stands for the rest of a group: Avatar group's (group.tsx) and Brand icon group's
// (src/components/brand-icon/group.tsx). Its box, its soft fill and the count in quiet ink, a
// face or a tile tall. Each group gives it its own width, corner and edge: a face's circle, or a
// tile's corner. Every value is a token.
import * as stylex from "@stylexjs/stylex";

import { grasp } from "../tokens/tokens.stylex";

export const groupMoreStyles = stylex.create({
  more: (size: string) => ({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    height: size,
    paddingInline: grasp.space1,
    backgroundColor: grasp.soft,
    fontFamily: grasp.fontSans,
    fontSize: `max(10px, calc(${size} * 0.4))`,
    fontWeight: grasp.weightMedium,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "-0.02em",
    color: grasp.muted,
    whiteSpace: "nowrap",
  }),
});
