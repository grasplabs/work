// Menubar: an application's menus in a row, one tab stop for all of them,
// in StyleX, built on UI SDK's
// Menubar and Menu: a quiet bar with the system's edge, triggers drawn as a list's items, and its
// menus in the raised panel the dropdown menu has, with items, checkbox and radio items, and
// submenus of their own.
//
//   <Menubar aria-label="Editor">
//     <MenubarMenu>
//       <MenubarTrigger>File</MenubarTrigger>
//       <MenubarContent>
//         <MenubarItem onSelect={create}>
//           New document <MenubarShortcut>mod+alt+n</MenubarShortcut>
//         </MenubarItem>
//       </MenubarContent>
//     </MenubarMenu>
//     <MenubarMenu>
//       <MenubarTrigger>View</MenubarTrigger>
//       <MenubarContent>
//         <MenubarCheckboxItem onCheckedChange={setRuler}>Show ruler</MenubarCheckboxItem>
//       </MenubarContent>
//     </MenubarMenu>
//   </Menubar>
//
// Tab enters the bar once; the arrows move between menus and through them.
"use client";

import * as stylex from "@stylexjs/stylex";
import { Menu, MenuContent, MenuSub, MenuTrigger } from "@ui-sdk/react/menu";
import type {
  MenuTriggerState,
  MenuCheckboxItem,
  MenuRadioGroup,
} from "@ui-sdk/react/menu";
import { Menubar as MenubarPrimitive } from "@ui-sdk/react/menubar";
import type { ComponentProps, ReactNode } from "react";

import type { IconData } from "../lib/icons";
import {
  MenuCheckboxItemPart,
  MenuGroupPart,
  MenuItemPart,
  MenuLabelPart,
  MenuRadioGroupPart,
  MenuRadioItemPart,
  MenuSeparatorPart,
  MenuShortcutPart,
  MenuSubContentPart,
  MenuSubTriggerPart,
} from "../lib/menu";
import type { MenuKind } from "../lib/menu";
import { focusRing, menuStyles, scrollbarHidden } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "../lib/tokens.stylex";
import { popup } from "../lib/tokens.values";
import { className, slotProps, slotted } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";

type OpenChange = ComponentProps<typeof Menu>["onOpenChange"];
type CheckedChange = ComponentProps<typeof MenuCheckboxItem>["onCheckedChange"];
type ValueChange = ComponentProps<typeof MenuRadioGroup>["onValueChange"];

// Every prop is documented once, here; the props on the docs page are read from these types.

/** Every prop a Menubar takes. */
export interface MenubarProps {
  /** Its MenubarMenus, in the order they stand. */
  children: ReactNode;
  /** The bar's name, when a page has more than one, as a screen reader and an agent say it ("Editor"). */
  "aria-label"?: string;
  /** Layout only: margins and alignment. */
  style?: LayoutStyle;
}

/** Every prop a MenubarMenu takes. */
export interface MenubarMenuProps {
  /** Its MenubarTrigger and MenubarContent. */
  children: ReactNode;
  /**
   * Runs when the menu wants to open or close; `details.reason` says why, and `details.cancel()`
   * keeps it as it is.
   */
  onOpenChange?: OpenChange;
}

/** Every prop a MenubarTrigger takes. */
export interface MenubarTriggerProps {
  /**
   * The trigger's words, one short word ("File", "Edit", "View"); with `asChild`, the one element
   * that is the trigger.
   */
  children: ReactNode;
  /**
   * Draws the one element given as the child as the trigger, with the trigger's props on it.
   * @default false
   */
  asChild?: boolean;
  /**
   * Out of use: the trigger stays in the bar but opens nothing.
   * @default false
   */
  disabled?: boolean;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a MenubarContent takes. */
export interface MenubarContentProps {
  /** The items, groups, labels, separators and submenus. None for a menu that is out of use. */
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a MenubarItem takes. */
export interface MenubarItemProps {
  /**
   * The words, a verb first ("Duplicate"), and a MenubarShortcut at the end when the action
   * has keys. Typing the first letters finds it, and an agent presses it by them. With `asChild`,
   * the one link that is the item, holding the words.
   */
  children: ReactNode;
  /**
   * Draws the one element given as the child (an `<a href>`, a router's link) as the item: it takes
   * the item's look, its words and its place in the arrows' order, and a press, Enter, a middle
   * click or a new tab follows it. The menu closes as it goes.
   * @default false
   */
  asChild?: boolean;
  /** An icon before the words. */
  icon?: IconData;
  /**
   * `destructive` for an item that deletes or cannot be undone: drawn in the destructive colour,
   * and an agent asks the person before pressing it.
   * @default "default"
   */
  variant?: "default" | "destructive";
  /**
   * Out of use: drawn at half strength and pressing it does nothing, but the keys still reach it,
   * as the menu pattern asks.
   * @default false
   */
  disabled?: boolean;
  /**
   * Runs when it is pressed, by pointer, Enter or Space. Call `event.preventDefault()` to keep the
   * menu open. Return a Promise and the menu stays open while it runs, with a spinner at the end of
   * the item, and closes once it is done; when it rejects, the item says `errorText` and the menu
   * stays open to try again.
   */
  onSelect?: (event: Event) => unknown;
  /**
   * Whether pressing it closes the menu.
   * @default true
   */
  closeOnSelect?: boolean;
  /**
   * What a screen reader hears as the work of an `onSelect` that returns a Promise starts.
   * @default "Working"
   */
  loadingText?: string;
  /**
   * The words when its work failed, at the end of the item, said aloud and given to an agent
   * ("Could not publish").
   * @default "Failed"
   */
  errorText?: string;
  /**
   * What the item does, for the person an agent must ask first ("Deletes the report"). A
   * `destructive` item asks with its own words when this is left out.
   */
  agentConfirm?: string;
  /** The words typing finds it by, when `children` is not plain words. */
  label?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a MenubarCheckboxItem takes. */
export interface MenubarCheckboxItemProps {
  /** The words on the option ("Show grid"). */
  children: ReactNode;
  /**
   * On now, with `onCheckedChange`: the page holds it, since the menu's items are taken out as it
   * closes.
   * @default false
   */
  checked?: boolean;
  /** Runs when it wants to turn on or off; `details.cancel()` keeps it as it is. */
  onCheckedChange?: CheckedChange;
  /**
   * Out of use: drawn at half strength, still reached by the keys.
   * @default false
   */
  disabled?: boolean;
  /**
   * Whether turning it over closes the menu.
   * @default false
   */
  closeOnSelect?: boolean;
  /** The words typing finds it by, when `children` is not plain words. */
  label?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a MenubarRadioGroup takes. */
export interface MenubarRadioGroupProps {
  /** A MenubarLabel, then its MenubarRadioItems. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
  /** The chosen option's value, with `onValueChange`: the page holds it. */
  value?: string | null;
  /** Runs when another option is chosen; `details.cancel()` keeps the choice as it is. */
  onValueChange?: ValueChange;
}

/** Every prop a MenubarRadioItem takes. */
export interface MenubarRadioItemProps {
  /** The words on the option ("Due date"). */
  children: ReactNode;
  /** The value its group takes when it is chosen. */
  value: string;
  /**
   * Out of use: drawn at half strength, still reached by the keys.
   * @default false
   */
  disabled?: boolean;
  /**
   * Whether choosing it closes the menu.
   * @default false
   */
  closeOnSelect?: boolean;
  /** The words typing finds it by, when `children` is not plain words. */
  label?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a MenubarGroup takes. */
export interface MenubarGroupProps {
  /** A MenubarLabel, then its items. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a MenubarLabel takes. */
export interface MenubarLabelProps {
  /** The group's name, in sentence case ("Sort by"). */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a MenubarSeparator takes. */
export interface MenubarSeparatorProps {
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a MenubarShortcut takes. */
export interface MenubarShortcutProps {
  /**
   * The keys that do the same elsewhere on the page, like `"mod+d"`: shown as ⌘D on a Mac and
   * Ctrl+D elsewhere, and named to a screen reader on its item. It shows the keys; binding them is
   * the page's.
   */
  children: string;
}

/** Every prop a MenubarSub takes. */
export interface MenubarSubProps {
  /** A MenubarSubTrigger and its MenubarSubContent. */
  children: ReactNode;
}

/** Every prop a MenubarSubTrigger takes. */
export interface MenubarSubTriggerProps {
  /** The words of the item that opens the submenu ("Share"). */
  children: ReactNode;
  /** An icon before the words. */
  icon?: IconData;
  /**
   * Out of use: drawn at half strength, still reached by the keys.
   * @default false
   */
  disabled?: boolean;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a MenubarSubContent takes. */
export interface MenubarSubContentProps {
  /** The submenu's items. */
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

const HOVER = media.hover;
const COARSE = media.pointerCoarse;
const FORCED = media.forcedColors;

const styles = stylex.create({
  // The bar: a hairline round the triggers, the one corner capped at half its height.
  bar: {
    display: "inline-flex",
    alignItems: "center",
    gap: space[1],
    maxWidth: "100%",
    boxSizing: "border-box",
    // On a touch screen the room above and below holds each trigger's 44px target, as in Tabs, so
    // the row's scrolling never cuts it.
    padding: {
      default: space[1],
      [COARSE]: `calc((${size.tapTarget} - ${size.controlSm}) / 2) ${space[1]}`,
    },
    borderWidth: { default: 0, [FORCED]: size.hairline },
    borderStyle: "solid",
    borderColor: "CanvasText",
    borderRadius: `min(${radius.xl}, calc((${size.controlSm} + 2 * ${space[1]}) / 2))`,
    cornerShape: radius.shape,
    boxShadow: size.borderStrong,
    fontFamily: font.sans,
    overflowX: "auto",
  },
  // A trigger: a list's item, in the bar. Lit under the pointer and while its menu is open.
  trigger: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    minHeight: size.controlSm,
    boxSizing: "border-box",
    margin: 0,
    paddingInline: space[3],
    paddingBlock: 0,
    borderWidth: 0,
    borderRadius: `min(calc(${radius.xl} - ${space[1]}), calc(${size.controlSm} / 2))`,
    cornerShape: radius.shape,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: colors.accentHighlight },
    },
    color: colors.foreground,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    cursor: "pointer",
    userSelect: "none",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    transitionProperty: "background-color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  // A finger needs 44px: an unseen area round the trigger makes up the difference.
  target: {
    position: "absolute",
    insetInline: 0,
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${size.controlSm} - ${size.tapTarget}) / 2)`,
    },
  },
  // In forced colours the trigger draws the system's highlight itself, so the browser puts no
  // backplate over its words.
  open: {
    forcedColorAdjust: { default: null, [FORCED]: "none" },
    backgroundColor: {
      default: colors.accentHighlight,
      [FORCED]: "Highlight",
    },
    color: { default: colors.foreground, [FORCED]: "HighlightText" },
  },
  // A disabled menu does not answer the pointer: no hover fill, so it never looks pressable.
  disabled: {
    opacity: size.opacityDisabled,
    cursor: "not-allowed",
    backgroundColor: "transparent",
  },
});

const kind: MenuKind = "menubar";

/** The bar: one tab stop for every menu, and the arrows between them. */
export const Menubar = ({
  children,
  "aria-label": ariaLabel,
  style,
}: MenubarProps) => (
  <MenubarPrimitive
    aria-label={ariaLabel}
    loop
    {...stylex.props(styles.bar, style)}
  >
    {children}
  </MenubarPrimitive>
);

/** One menu of the bar: holds its trigger and its content. An item with work keeps it open while it runs. */
export const MenubarMenu = ({ children, onOpenChange }: MenubarMenuProps) => (
  <Menu
    onOpenChange={onOpenChange}
    // Silent: an item says its own work once it starts, with its own words.
    pendingAnnouncement=""
  >
    {children}
  </Menu>
);

/** The menu's trigger, in the bar: lit under the pointer and while its menu is open. */
export const MenubarTrigger = ({
  children,
  asChild = false,
  disabled,
  style,
}: MenubarTriggerProps) => {
  const slot = slotProps(asChild, children);
  return (
    <MenuTrigger
      disabled={disabled}
      render={slotted("button", "menubar-trigger", slot.render)}
      className={(state: MenuTriggerState) =>
        className(
          styles.trigger,
          state.open && styles.open,
          state.disabled && styles.disabled,
          focusRing,
          style
        )
      }
    >
      {/* With asChild the element keeps its own children, and its own reach. */}
      {slot.render === undefined ? (
        <>
          <span aria-hidden="true" {...stylex.props(styles.target)} />
          {children}
        </>
      ) : undefined}
    </MenuTrigger>
  );
};

// A menu stands menu-gap off its trigger: past the bar's own room round the trigger, so its edge
// stands clear of the bar's instead of merging with it.
/** The menu, under its trigger. */
export const MenubarContent = ({ children, style }: MenubarContentProps) => (
  <MenuContent
    align="start"
    sideOffset={popup.menuGap}
    collisionPadding={popup.gutter}
    render={slotted("div", "menubar-content")}
    {...stylex.props(
      menuStyles.panel,
      menuStyles.motion,
      scrollbarHidden,
      style
    )}
  >
    {children}
  </MenuContent>
);

/** The keys at the end of an item: ⌘D on a Mac, Ctrl+D elsewhere. Hidden from screen readers. */
export const MenubarShortcut = ({ children }: MenubarShortcutProps) => (
  <MenuShortcutPart kind={kind}>{children}</MenuShortcutPart>
);

/** An action in the menu. */
export const MenubarItem = (props: MenubarItemProps) => (
  <MenuItemPart {...props} kind={kind} shortcut={MenubarShortcut} />
);

/** An option that is on or off, with a tick while it is on. */
export const MenubarCheckboxItem = (props: MenubarCheckboxItemProps) => (
  <MenuCheckboxItemPart {...props} kind={kind} />
);

/** A set of options, one of them chosen. */
export const MenubarRadioGroup = (props: MenubarRadioGroupProps) => (
  <MenuRadioGroupPart {...props} kind={kind} />
);

/** One option of a radio group, with a dot while it is chosen. */
export const MenubarRadioItem = (props: MenubarRadioItemProps) => (
  <MenuRadioItemPart {...props} kind={kind} />
);

/** A group of items, named by its label. */
export const MenubarGroup = (props: MenubarGroupProps) => (
  <MenuGroupPart {...props} kind={kind} />
);

/** A group's name, above its items. */
export const MenubarLabel = (props: MenubarLabelProps) => (
  <MenuLabelPart {...props} kind={kind} />
);

/** A line between groups of items, edge to edge. */
export const MenubarSeparator = (props: MenubarSeparatorProps) => (
  <MenuSeparatorPart {...props} kind={kind} />
);

/** A submenu: holds its MenubarSubTrigger and MenubarSubContent. */
export const MenubarSub = ({ children }: MenubarSubProps) => (
  <MenuSub>{children}</MenuSub>
);

/** The item that opens its submenu, with a chevron pointing the way it opens. */
export const MenubarSubTrigger = (props: MenubarSubTriggerProps) => (
  <MenuSubTriggerPart {...props} kind={kind} />
);

/** The submenu, beside its trigger. */
export const MenubarSubContent = (props: MenubarSubContentProps) => (
  <MenuSubContentPart {...props} kind={kind} />
);
