// Heading's type: the title sizes from the scale, from the tokens. Heading draws them, and a part
// whose title is a Heading's (Page header's h1, Heading's `lg`) builds on the same styles, so the
// two never drift apart.
import * as stylex from "@stylexjs/stylex";

import { grasp, media } from "../tokens/tokens.stylex";

/** A title's look, from the largest: an opening title down to a component's own. */
export type HeadingSize = "xl" | "lg" | "md" | "sm" | "ui" | "ui-sm";

export const headingStyles = stylex.create({
  heading: {
    margin: 0,
    color: grasp.ink,
    // A long word breaks inside itself rather than run out of its box.
    overflowWrap: "break-word",
    textWrap: "balance",
  },
  serif: {
    fontFamily: grasp.fontSerif,
    fontWeight: grasp.weightRegular,
    letterSpacing: grasp.trackingTitle,
  },
  xl: {
    fontSize: { default: grasp.titleXl, [media.belowPhone]: grasp.titleLg },
    lineHeight: {
      default: grasp.titleXlLine,
      [media.belowPhone]: grasp.titleLgLine,
    },
  },
  lg: { fontSize: grasp.titleLg, lineHeight: grasp.titleLgLine },
  md: { fontSize: grasp.titleMd, lineHeight: grasp.titleMdLine },
  sm: { fontSize: grasp.titleSm, lineHeight: grasp.titleSmLine },
  ui: {
    fontFamily: grasp.fontSans,
    fontWeight: grasp.weightMedium,
    fontSize: grasp.titleUi,
    lineHeight: grasp.titleUiLine,
    letterSpacing: grasp.trackingUiTitle,
  },
  // The interface's own size, so a title over a group of settings stands as tall as its words and
  // is told apart by weight: text-sm, at 500.
  "ui-sm": {
    fontFamily: grasp.fontSans,
    fontWeight: grasp.weightMedium,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    letterSpacing: grasp.trackingUi,
  },
});

/** A title's whole look at a size: the heading's own, the serif from title-sm up, and the size. */
export const headingLook = (size: HeadingSize) => [
  headingStyles.heading,
  size !== "ui" && size !== "ui-sm" && headingStyles.serif,
  headingStyles[size],
];
