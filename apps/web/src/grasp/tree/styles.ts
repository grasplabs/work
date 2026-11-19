// The look of a tree (tree.tsx): rows the height of a small control, each level a step in, a
// chevron that turns as a branch opens, an icon, and the words. Lit under a pointer and while
// chosen, in the list items' fills. Palermo has no tree; the rows follow Grasp's Select items.
import * as stylex from "@stylexjs/stylex";

import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { treeRowMarker } from "./tree.stylex";

const HOVER = media.hover;
const chosen = ":is([data-selected], [data-current])";
const COARSE = media.coarse;
// A branch's row: open, under a pointer, with the keys on its item. Its chevron takes the icon's
// place then, when the chevron is seated there (seat.ts).
const BRANCH = ":is([data-branch])";
const OPEN = ":is([data-branch][data-expanded])";
const POINTED = ":is([data-branch]:hover)";
const KEYED = ":is([data-slot=tree-item]:focus-visible > [data-branch])";
const LEAD = `calc(${grasp.treeRowInset} + (var(--tree-level, 1) - 1) * ${grasp.treeIndent})`;

// The tree guide's measures (`guides`), the Sidebar's own: a row's middle; the stem's column, under
// the parent's chevron (a level's chevron stands at its row's lead, in either seat); the elbow, a
// space-3 round unless the indent is too short for it.
const ROW_MIDDLE = `calc(${grasp.treeRow} / 2)`;
const ROW_MIDDLE_TOUCH = `calc(${grasp.treeRowTouch} / 2)`;
const GUIDE_X = `calc(${grasp.treeRowInset} + (var(--tree-level, 2) - 2) * ${grasp.treeIndent} + ${grasp.iconSm} / 2 - ${grasp.treeGuide} / 2)`;
const GUIDE_ELBOW = `min(${grasp.space3}, calc(${grasp.treeIndent} - ${grasp.space1}))`;
const guideLine = { default: grasp.line, [media.forced]: "GrayText" };

export const treeStyles = stylex.create({
  tree: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.treeRowGap,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    margin: 0,
    padding: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.treeText,
    listStyle: "none",
  },
  // An item holds its row and, when it is a branch, its group. Focus is on the item; its row
  // shows it (row, below), as the item also holds its children.
  item: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.treeRowGap,
    minWidth: 0,
    outline: "none",
  },
  group: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.treeRowGap,
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
    gap: grasp.treeIconGap,
    boxSizing: "border-box",
    minWidth: 0,
    minHeight: { default: grasp.treeRow, [media.coarse]: grasp.treeRowTouch },
    paddingInlineStart: LEAD,
    paddingInlineEnd: grasp.treeRowInset,
    borderRadius: grasp.treeRowCorner,
    cornerShape: grasp.cornerShape,
    // Chosen or current: a fill, which forced colours drop, so the system's highlight there.
    letterSpacing: grasp.treeTracking,
    color: {
      default: grasp.treeText,
      ":hover:not([data-selected], [data-current])": {
        default: null,
        [HOVER]: grasp.treeTextHover,
      },
      [chosen]: {
        default: grasp.treeTextChosen,
        [media.forced]: "HighlightText",
      },
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
    fontWeight: {
      default: grasp.treeWeight,
      ":is([data-current])": grasp.treeWeightCurrent,
    },
    cursor: { default: "pointer", ":is([data-disabled])": "default" },
    opacity: { default: 1, ":is([data-disabled])": grasp.dim },
    userSelect: "none",
    transitionProperty: "color, background-color",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
    // Keyboard focus is on the item, which holds its children too: the row wears the ring
    // (focus.row, src/focus/focus.ts), last in tree.tsx.
  },
  // The chevron: turns a quarter as its branch opens; at once with reduced motion.
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    color: grasp.treeIcon,
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
    color: grasp.treeIcon,
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
    gap: grasp.treeIconGap,
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
    // Its own weight and spacing, whatever the row's words take.
    fontWeight: grasp.weightRegular,
    letterSpacing: "normal",
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
  // The chevron in the icon's place (seat.ts): the row holds it, laid over where the icon stands,
  // unseen until the branch is open, under a pointer, has the keys, or always on a touch screen,
  // where no pointer rests over a row. Pressed, it still folds the branch.
  rowSeated: { position: "relative" },
  chevronSeated: {
    position: "absolute",
    insetBlock: 0,
    insetInlineStart: LEAD,
    zIndex: 1,
    alignItems: "center",
    width: grasp.iconSm,
    opacity: {
      default: 0,
      [stylex.when.ancestor(OPEN, treeRowMarker)]: 1,
      [stylex.when.ancestor(POINTED, treeRowMarker)]: {
        default: null,
        [HOVER]: 1,
      },
      [stylex.when.ancestor(KEYED, treeRowMarker)]: 1,
      [COARSE]: 1,
    },
    transitionProperty: "opacity, transform",
  },
  // The branch's icon gives its place to the chevron at those times.
  iconSeated: {
    opacity: {
      default: 1,
      [stylex.when.ancestor(OPEN, treeRowMarker)]: 0,
      [stylex.when.ancestor(POINTED, treeRowMarker)]: {
        default: null,
        [HOVER]: 0,
      },
      [stylex.when.ancestor(KEYED, treeRowMarker)]: 0,
      [stylex.when.ancestor(BRANCH, treeRowMarker)]: {
        default: null,
        [COARSE]: 0,
      },
    },
    transitionProperty: "opacity",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
  },
  // There no row keeps a chevron column: a row with no icon keeps the icon's room instead.
  spacerSeated: { display: "none" },
  // The tree guide on a nested item (`guides`), over the rows' fills: the stem from the gap above
  // down to the elbow, the elbow into the row, and the stem on past the item to its next sibling,
  // which the last item has not.
  guided: { position: "relative" },
  guideStem: {
    position: "absolute",
    zIndex: 1,
    insetInlineStart: GUIDE_X,
    insetBlockStart: `calc(-1 * ${grasp.treeRowGap})`,
    height: {
      default: `calc(${grasp.treeRowGap} + ${ROW_MIDDLE} - ${GUIDE_ELBOW})`,
      [COARSE]: `calc(${grasp.treeRowGap} + ${ROW_MIDDLE_TOUCH} - ${GUIDE_ELBOW})`,
    },
    width: 0,
    borderInlineStartWidth: grasp.treeGuide,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: guideLine,
    pointerEvents: "none",
  },
  guideStemOn: {
    position: "absolute",
    zIndex: 1,
    insetInlineStart: GUIDE_X,
    insetBlockStart: {
      default: `calc(${ROW_MIDDLE} - ${GUIDE_ELBOW})`,
      [COARSE]: `calc(${ROW_MIDDLE_TOUCH} - ${GUIDE_ELBOW})`,
    },
    insetBlockEnd: 0,
    width: 0,
    borderInlineStartWidth: grasp.treeGuide,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: guideLine,
    pointerEvents: "none",
  },
  // The elbow runs to a step before what leads the row: past the chevron column to its icon (a
  // tree's own seat), or to the seat itself where the chevron stands in the icon's place.
  guideBranch: {
    position: "absolute",
    zIndex: 1,
    insetInlineStart: GUIDE_X,
    insetBlockStart: {
      default: `calc(${ROW_MIDDLE} - ${GUIDE_ELBOW})`,
      [COARSE]: `calc(${ROW_MIDDLE_TOUCH} - ${GUIDE_ELBOW})`,
    },
    boxSizing: "border-box",
    height: GUIDE_ELBOW,
    width: `calc(${grasp.treeIndent} + ${grasp.iconSm} / 2 + ${grasp.treeIconGap} - ${grasp.space1} + ${grasp.treeGuide} / 2)`,
    borderInlineStartWidth: grasp.treeGuide,
    borderBlockEndWidth: grasp.treeGuide,
    borderStyle: "solid",
    borderColor: guideLine,
    borderBlockStartColor: "transparent",
    borderInlineEndColor: "transparent",
    borderEndStartRadius: GUIDE_ELBOW,
    pointerEvents: "none",
  },
  // A step before the row's seat, where the chevron stands in the icon's place. (In a tree's own
  // seat a child's chevron stands half an indent from its parent's: too near for an elbow, so the
  // elbow runs on under it to the icon, the chevron standing on the line.)
  guideBranchShort: {
    width: `calc(${grasp.treeIndent} - ${grasp.iconSm} / 2 - ${grasp.space1} + ${grasp.treeGuide} / 2)`,
  },
  // A leaf with no icon in the icon's seat: the elbow runs on through the empty seat, to a step
  // before the words.
  guideBranchToWords: {
    width: `calc(${grasp.treeIndent} + ${grasp.iconSm} / 2 + ${grasp.treeIconGap} - ${grasp.space1} + ${grasp.treeGuide} / 2)`,
  },
  // Where the stem carries on, the elbow leaves the stem's column to it: one layer of line there.
  guideBranchCut: {
    clipPath: {
      default: `inset(0 0 0 ${grasp.treeGuide})`,
      ":dir(rtl)": `inset(0 ${grasp.treeGuide} 0 0)`,
    },
  },
});
