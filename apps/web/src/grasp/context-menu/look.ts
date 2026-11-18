// Context menu's look for Dropdown menu's parts (dropdown-menu/look.ts): the popup Select and
// Command share, with Palermo's menu items, as menu-items.tsx draws the older shape's. Its panel
// gives it to the parts inside, so a menu written in parts looks as one written as data.
import * as stylex from "@stylexjs/stylex";

import { listStyles } from "../combobox/list.styles";
import type { MenuLook } from "../dropdown-menu/look";
import { menuMarker } from "../dropdown-menu/menu.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

const spin = stylex.keyframes({
  from: { transform: "rotate(0turn)" },
  to: { transform: "rotate(1turn)" },
});

const styles = stylex.create({
  // Working: the spinner at the end turns; with reduced motion it stands still.
  spinner: {
    animationName: { default: spin, [media.reduced]: "none" },
    animationDuration: grasp.durationSpin,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  failed: {
    color: grasp.danger,
  },
  pending: {
    cursor: "progress",
  },
  // A tick sits at the end, where the shortcut would.
  indicator: {
    display: "inline-flex",
    flexShrink: 0,
    marginInlineStart: "auto",
    color: grasp.ink,
  },
  // The chosen one of a radio group: a dot in the tick's place, as wide as an icon.
  dot: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: grasp.iconSm,
    height: grasp.iconSm,
    marginInlineStart: "auto",
    "::before": {
      content: '""',
      width: `calc(${grasp.iconSm} * 0.375)`,
      height: `calc(${grasp.iconSm} * 0.375)`,
      borderRadius: grasp.cornerCircle,
      backgroundColor: {
        default: "currentColor",
        [media.forced]: "CanvasText",
      },
    },
  },
  // The words of an item with no icon, in a panel where another item has one: they start past an
  // empty icon slot, where the others' words do (eyes-a A-nav-08). In a panel with no icon at all
  // they start at the item's edge.
  wordsBare: {
    paddingInlineStart: {
      default: null,
      [stylex.when.ancestor(":has([data-menu-icon])", menuMarker)]:
        `calc(${grasp.iconSm} + ${grasp.space2})`,
    },
  },
});

/** Context menu's look, for the parts in its panel. Menubar's menus take it too. */
export const contextMenuLook: MenuLook = {
  item: [listStyles.item, listStyles.menuItem],
  highlighted: listStyles.itemHighlighted,
  disabled: listStyles.itemDisabled,
  // Danger keeps its colour under the highlight.
  danger: listStyles.itemDanger,
  dangerHighlighted: false,
  pending: styles.pending,
  icon: listStyles.itemIcon,
  iconDanger: listStyles.itemIconDanger,
  words: listStyles.itemWords,
  wordsBare: styles.wordsBare,
  end: listStyles.itemEnd,
  failed: styles.failed,
  spinner: styles.spinner,
  tick: styles.indicator,
  dot: styles.dot,
  label: listStyles.groupLabel,
  separator: listStyles.separator,
};
