// One look for a section that folds inside prose, shared by Markdown (what is shown) and
// DocumentEditor (what is written), so the two cannot drift apart. A document block, as Notion's and
// Linear's toggles are, not a panel's disclosure (that is Collapsible): the chevron before the
// summary, pointing along the line while closed and turned down while open; the summary at the
// body's size in the medium weight; the body indented to the summary's first letter.
import * as stylex from "@stylexjs/stylex";

import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

const HOVER = media.hover;

export const sectionStyles = stylex.create({
  // Toggle and summary on the first row, the body under the summary on the second.
  section: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    columnGap: grasp.space1,
    alignItems: "start",
  },
  // The toggle: a square of the summary's line, the chevron in its middle.
  toggle: {
    gridColumn: "1",
    gridRow: "1",
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1lh",
    height: "1lh",
    padding: 0,
    margin: 0,
    borderWidth: 0,
    borderRadius: grasp.cornerMark,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: grasp.ghostFillHover },
      ":active": grasp.ghostFillPress,
    },
    color: grasp.muted,
    font: "inherit",
    cursor: "pointer",
  },
  // The chevron's holder turns (the drawing itself mirrors right to left, as a pointing icon does).
  chevron: {
    display: "inline-flex",
    transitionProperty: "transform",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  // Open, it points down: a quarter turn from along the line, either way round.
  chevronOpen: {
    transform: { default: "rotate(90deg)", ":dir(rtl)": "rotate(-90deg)" },
  },
  // A drawing made by hand (DocumentEditor's, inside Tiptap's own button), as Icon draws one.
  drawing: {
    display: "block",
    width: grasp.iconSm,
    height: grasp.iconSm,
    stroke: "currentColor",
    strokeWidth: grasp.iconStroke,
    pointerEvents: "none",
    transform: { default: null, ":dir(rtl)": "scaleX(-1)" },
  },
  summary: {
    gridColumn: "2",
    gridRow: "1",
    display: "block",
    minWidth: 0,
    margin: 0,
    listStyleType: "none",
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  // Under the summary, from its first letter: the answer's own column of blocks.
  body: {
    gridColumn: "2",
    gridRow: "2",
    display: { default: "flex", ":is([hidden])": "none" },
    flexDirection: "column",
    gap: grasp.space4,
    minWidth: 0,
    paddingBlockStart: grasp.space2,
  },
});
