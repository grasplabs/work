// The look of a tree (tree.tsx): rows the height of a small control, each level a step in, a
// chevron that turns as a branch opens, an icon, and the words. Lit under a pointer and while
// chosen, in the list items' fills. Palermo has no tree; the rows follow Grasp's Select items.
import * as stylex from "@stylexjs/stylex";

import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

const HOVER = media.hover;
const chosen = ":is([data-selected], [data-current])";

export const treeStyles = stylex.create({
  tree: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.hairline,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    margin: 0,
    padding: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.text,
    listStyle: "none",
  },
  // An item holds its row and, when it is a branch, its group. Focus is on the item; its row
  // shows it (row, below), as the item also holds its children.
  item: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.hairline,
    minWidth: 0,
    outline: "none",
  },
  group: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.hairline,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // A row: a step in per level, the chevron, the icon, the words.
  row: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    boxSizing: "border-box",
    minWidth: 0,
    minHeight: { default: grasp.treeRow, [media.coarse]: grasp.treeRowTouch },
    paddingInlineStart: `calc(${grasp.treeRowInset} + (var(--tree-level, 1) - 1) * ${grasp.treeIndent})`,
    paddingInlineEnd: grasp.treeRowInset,
    borderRadius: grasp.treeRowCorner,
    cornerShape: grasp.cornerShape,
    // Chosen or current: a fill, which forced colours drop, so the system's highlight there.
    color: {
      default: grasp.text,
      [chosen]: { default: grasp.ink, [media.forced]: "HighlightText" },
    },
    // Three fills, each its own, so a row under a pointer, a chosen row and the current page are
    // told apart: the pointer's quiet fill, the mint wash of a chosen row (as in a Table), and
    // for the current page a stronger fill under heavier words.
    backgroundColor: {
      default: "transparent",
      // Hover never covers the chosen fill.
      ":hover:not([data-selected], [data-current])": {
        default: null,
        [HOVER]: grasp.treeFillHover,
      },
      ":is([data-selected])": {
        default: grasp.treeFillChosen,
        [media.forced]: "Highlight",
      },
      ":is([data-current])": {
        default: grasp.treeFillCurrent,
        [media.forced]: "Highlight",
      },
    },
    fontWeight: { default: null, ":is([data-current])": grasp.weightMedium },
    cursor: { default: "pointer", ":is([data-disabled])": "default" },
    opacity: { default: 1, ":is([data-disabled])": grasp.dim },
    userSelect: "none",
    transitionProperty: "background-color",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
    // Keyboard focus is on the item, which holds its children too: the row wears the ring
    // (focus.row, src/focus/focus.ts), last in tree.tsx.
  },
  // The chevron: turns a quarter as its branch opens; at once with reduced motion.
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    color: grasp.muted,
    transform: { default: "none", ":is([data-expanded])": "rotate(90deg)" },
    transitionProperty: "transform",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  // A leaf has no chevron: the room it would take keeps its icon in line with its siblings'.
  spacer: {
    display: "inline-block",
    flexShrink: 0,
    width: grasp.iconSm,
  },
  icon: {
    display: "inline-flex",
    flexShrink: 0,
    color: grasp.muted,
  },
  failed: {
    color: grasp.danger,
  },
  words: {
    minWidth: 0,
    overflowWrap: "anywhere",
    paddingBlock: grasp.space1,
  },
});
