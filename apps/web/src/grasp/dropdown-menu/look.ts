// The look a dropdown menu's parts are drawn in. Dropdown menu's own by default (styles.ts); a menu
// that takes these parts in a look of its own gives that look to its panel with MenuLookProvider:
// Context menu's panel does, so its items are Dropdown menu's parts drawn as Context menu's always
// were. One set of parts, one behaviour, and each menu keeps its look.
import type * as stylex from "@stylexjs/stylex";
import { createContext, useContext } from "react";

import { menuStyles } from "./styles";

/** One style, or several, as `stylex.props` takes them; `false` for none. */
type Style = stylex.StyleXArray<stylex.CompiledStyles | false>;

/** Every style a menu's parts are drawn with. `false` where a look has nothing to add. */
export interface MenuLook {
  /** An item, a checkbox item and a radio item. */
  item: Style;
  highlighted: Style;
  disabled: Style;
  danger: Style;
  /** A danger item where the keyboard or the pointer is. */
  dangerHighlighted: Style;
  pending: Style;
  icon: Style;
  /** A danger item's icon. */
  iconDanger: Style;
  words: Style;
  /** The words of an item with no icon, in a panel where another item has one. */
  wordsBare: Style;
  /** The end of an item: its keys, its work, its failure. */
  end: Style;
  failed: Style;
  spinner: Style;
  /** A checkbox item's tick. */
  tick: Style;
  /** A radio item's dot. */
  dot: Style;
  label: Style;
  separator: Style;
}

/** Dropdown menu's own look. */
export const dropdownMenuLook: MenuLook = {
  item: menuStyles.item,
  highlighted: menuStyles.highlighted,
  disabled: menuStyles.disabled,
  danger: menuStyles.danger,
  dangerHighlighted: menuStyles.dangerHighlighted,
  pending: menuStyles.pending,
  icon: menuStyles.icon,
  iconDanger: false,
  words: menuStyles.words,
  wordsBare: menuStyles.wordsBare,
  end: menuStyles.end,
  failed: menuStyles.failed,
  spinner: menuStyles.spinner,
  tick: menuStyles.tick,
  dot: menuStyles.dot,
  label: menuStyles.label,
  separator: menuStyles.separator,
};

const LookContext = createContext<MenuLook>(dropdownMenuLook);
/** Gives the parts inside a menu's panel that menu's look. */
export const MenuLookProvider = LookContext.Provider;
/** The look of the panel a part stands in. */
export const useMenuLook = () => useContext(LookContext);
