// The look of a tree (tree.tsx): rows the height of a small control, each level a step in, a
// chevron that turns as a branch opens, an icon, and the words. Lit under a pointer and while
// chosen, in the list items' fills. Palermo has no tree; the rows follow Grasp's Select items.
import * as stylex from "@stylexjs/stylex";

import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

const HOVER = media.hover;
const chosen = ":is([data-selected], [data-current])";

// The tree guide's measures: a row's middle, where the parent level's chevron stands (its row's
// inset, a step in per level above this one, and half the chevron), and the elbow.
const ROW_MIDDLE = `calc(${grasp.treeRow} / 2)`;
const GUIDE_X = `calc(${grasp.treeRowInset} + (var(--tree-level, 2) - 2) * ${grasp.treeIndent} + ${grasp.iconSm} / 2 - ${grasp.hairline} / 2)`;
const GUIDE_ELBOW = `min(${grasp.space3}, calc(${grasp.treeIndent} - ${grasp.space1}))`;

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
  // A nested item that draws its part of the tree guide (`guides`).
  guided: { position: "relative" },
  // The guide's stem, from the gap above to the elbow, under the branch's chevron: a level's
  // chevron stands at the row's inset, a step in per level.
  guideStem: {
    position: "absolute",
    insetInlineStart: GUIDE_X,
    insetBlockStart: `calc(-1 * ${grasp.hairline})`,
    height: `calc(${grasp.hairline} + ${ROW_MIDDLE} - ${GUIDE_ELBOW})`,
    width: 0,
    borderInlineStartWidth: grasp.hairline,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: { default: grasp.line, [media.forced]: "GrayText" },
    pointerEvents: "none",
  },
  // Below the elbow to the item's foot: the stem carries on to the next sibling.
  guideStemOn: {
    position: "absolute",
    insetInlineStart: GUIDE_X,
    insetBlockStart: `calc(${ROW_MIDDLE} - ${GUIDE_ELBOW})`,
    insetBlockEnd: 0,
    width: 0,
    borderInlineStartWidth: grasp.hairline,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: { default: grasp.line, [media.forced]: "GrayText" },
    pointerEvents: "none",
  },
  // The elbow into the row, to a step before its words (past the room its chevron takes).
  guideBranch: {
    position: "absolute",
    insetInlineStart: GUIDE_X,
    insetBlockStart: `calc(${ROW_MIDDLE} - ${GUIDE_ELBOW})`,
    boxSizing: "border-box",
    height: GUIDE_ELBOW,
    width: `calc(${grasp.treeIndent} + ${grasp.iconSm} / 2 + ${grasp.space2} - ${grasp.space1})`,
    borderInlineStartWidth: grasp.hairline,
    borderBlockEndWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: { default: grasp.line, [media.forced]: "GrayText" },
    borderBlockStartColor: "transparent",
    borderInlineEndColor: "transparent",
    borderEndStartRadius: GUIDE_ELBOW,
    pointerEvents: "none",
  },
  // Where the stem carries on, the elbow leaves the stem's column to it: one layer of line there.
  guideBranchCut: {
    clipPath: {
      default: `inset(0 0 0 ${grasp.hairline})`,
      ":dir(rtl)": `inset(0 ${grasp.hairline} 0 0)`,
    },
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
  // A row that is a link (a node's `href` or `render`): the link fills the row from the icon to its
  // end, so a press anywhere there is the link's, and looks as the row's words do.
  link: {
    display: "flex",
    flexGrow: 1,
    alignItems: "center",
    alignSelf: "stretch",
    gap: grasp.space2,
    minWidth: 0,
    color: "inherit",
    textDecoration: "none",
    outline: "none",
  },
  // At the row's end: a count, a mark. Quiet, never squeezed, after the words.
  end: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    flexShrink: 0,
    marginInlineStart: "auto",
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontVariantNumeric: "tabular-nums",
  },
  // A tree with its filter: the field over the tree, a step apart.
  filtered: {
    display: "grid",
    gap: grasp.space2,
    minWidth: 0,
  },
  // Nothing matches: one quiet line in the tree's place.
  none: {
    margin: 0,
    paddingBlock: grasp.space1,
    paddingInline: grasp.space2,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
});
