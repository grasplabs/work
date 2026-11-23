// ContextMenu: the actions for a thing, opened where it is right-clicked or long-pressed,
// in StyleX, built on UI SDK's Menu with its context trigger: the raised panel the dropdown menu has, items with an
// icon, words and keys, checkbox and radio items, submenus, and an item whose work can fail.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <ContextMenu>
//     <ContextMenuTrigger aria-label="Q3 forecast">
//       <FileRow />
//     </ContextMenuTrigger>
//     <ContextMenuContent>
//       <ContextMenuItem icon={ArrowRightIcon} onSelect={open}>Open</ContextMenuItem>
//       <ContextMenuItem onSelect={rename}>
//         Rename <ContextMenuShortcut>f2</ContextMenuShortcut>
//       </ContextMenuItem>
//       <ContextMenuSeparator />
//       <ContextMenuItem variant="destructive" onSelect={remove}>Move to trash</ContextMenuItem>
//     </ContextMenuContent>
//   </ContextMenu>
//
// The area takes a tab stop, so Shift+F10 or the menu key opens it from the keyboard (with
// `tabStop={false}` the thing inside it that takes the keys does, a row's link). Everything in it
// must also be reachable another way: a context menu is a shortcut, never the only door.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { MenuCheckboxItem, MenuRadioGroup } from "@ui-sdk/react/menu";
import {
  Menu,
  MenuContent,
  MenuContextTrigger,
  MenuSub,
} from "@ui-sdk/react/menu";
import { createContext, use, useRef } from "react";
import type { ComponentProps, KeyboardEvent, ReactNode } from "react";

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
import { radius } from "../lib/tokens.stylex";
import { popup } from "../lib/tokens.values";
import { slotProps, slotted } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { menuMarker } from "../lib/vars.stylex";

type FinalFocus = ComponentProps<typeof MenuContent>["finalFocus"];
type OpenChange = ComponentProps<typeof Menu>["onOpenChange"];
type CheckedChange = ComponentProps<typeof MenuCheckboxItem>["onCheckedChange"];
type ValueChange = ComponentProps<typeof MenuRadioGroup>["onValueChange"];

// Every prop is documented once, here; the props on the docs page are read from these types.

/** Every prop a ContextMenu takes. */
export interface ContextMenuProps {
  /** A ContextMenuTrigger round the area and a ContextMenuContent with its items. */
  children: ReactNode;
  /**
   * Runs when the menu wants to open or close; `details.reason` says why, and `details.cancel()`
   * keeps it as it is.
   */
  onOpenChange?: OpenChange;
  /**
   * The browser's own menu shows instead, and the area takes no tab stop.
   * @default false
   */
  disabled?: boolean;
}

/** Every prop a ContextMenuTrigger takes. */
export interface ContextMenuTriggerProps {
  /** The area it opens on: a row, a card, a canvas. With `asChild`, the one element that is the area. */
  children: ReactNode;
  /**
   * The area's name, as a screen reader and an agent say it: the thing the actions are for
   * ("Q3 forecast"). Not said with `tabStop={false}`, where the thing inside carries the name.
   */
  "aria-label": string;
  /**
   * Draws the one element given as the child as the area, with the area's props on it.
   * @default false
   */
  asChild?: boolean;
  /**
   * Whether the area takes a tab stop of its own. `false` when the area holds the thing the keys
   * reach (a row's link): the menu key and Shift+F10 on it still open the menu, as they bubble,
   * and the area is then no group of its own: the thing inside is what is named.
   * @default true
   */
  tabStop?: boolean;
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

/** Every prop a ContextMenuContent takes. */
export interface ContextMenuContentProps {
  /** The items, groups, labels, separators and submenus. */
  children?: ReactNode;
  /**
   * Where focus goes as the menu closes: back to the area by default; an element, a function that
   * finds one (the row's link, when the area takes no tab stop), or `"none"` when the chosen action
   * moves focus itself (a rename field).
   * @default "trigger"
   */
  finalFocus?: FinalFocus;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a ContextMenuItem takes. */
export interface ContextMenuItemProps {
  /**
   * The words, a verb first ("Duplicate"), and a ContextMenuShortcut at the end when the action
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
   * the item, and closes once it is done; when it rejects, the item says `errorLabel` and the menu
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
  loadingLabel?: string;
  /**
   * The words when its work failed, at the end of the item, said aloud and given to an agent
   * ("Could not publish").
   * @default "Failed"
   */
  errorLabel?: string;
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

/** Every prop a ContextMenuCheckboxItem takes. */
export interface ContextMenuCheckboxItemProps {
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

/** Every prop a ContextMenuRadioGroup takes. */
export interface ContextMenuRadioGroupProps {
  /** A ContextMenuLabel, then its ContextMenuRadioItems. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
  /** The chosen option's value, with `onValueChange`: the page holds it. */
  value?: string | null;
  /** Runs when another option is chosen; `details.cancel()` keeps the choice as it is. */
  onValueChange?: ValueChange;
}

/** Every prop a ContextMenuRadioItem takes. */
export interface ContextMenuRadioItemProps {
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

/** Every prop a ContextMenuGroup takes. */
export interface ContextMenuGroupProps {
  /** A ContextMenuLabel, then its items. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a ContextMenuLabel takes. */
export interface ContextMenuLabelProps {
  /** The group's name, in sentence case ("Sort by"). */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a ContextMenuSeparator takes. */
export interface ContextMenuSeparatorProps {
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a ContextMenuShortcut takes. */
export interface ContextMenuShortcutProps {
  /**
   * The keys that do the same elsewhere on the page, like `"mod+d"`: shown as ⌘D on a Mac and
   * Ctrl+D elsewhere, and named to a screen reader on its item. It shows the keys; binding them is
   * the page's.
   */
  children: string;
}

/** Every prop a ContextMenuSub takes. */
export interface ContextMenuSubProps {
  /** A ContextMenuSubTrigger and its ContextMenuSubContent. */
  children: ReactNode;
}

/** Every prop a ContextMenuSubTrigger takes. */
export interface ContextMenuSubTriggerProps {
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

/** Every prop a ContextMenuSubContent takes. */
export interface ContextMenuSubContentProps {
  /** The submenu's items. */
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

const styles = stylex.create({
  // The area: as it is, with the shared focus ring when the keyboard reaches it.
  area: {
    display: "block",
    borderRadius: radius.base,
    cornerShape: radius.shape,
    WebkitTouchCallout: "none",
  },
});

const kind: MenuKind = "context-menu";

// Whether the root is out of use, for its trigger.
const Disabled = createContext(false);

// Shift+F10 and the menu key: not every browser turns them into a contextmenu event (Chrome on a
// Mac does not), so the key raises one itself, from where focus is, and stops the browser's own.
// UI SDK reads a contextmenu event that is not from a pointer as the keyboard's, and opens the
// menu at the focused element; a second one, where a browser still sends it, opens it in place.
const openByKey = (event: KeyboardEvent<HTMLElement>) => {
  const menuKey =
    event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
  if (!menuKey || event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }
  event.preventDefault();
  event.target.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
  );
};

/**
 * The root: holds a ContextMenuTrigger and a ContextMenuContent, and renders nothing of its own.
 * An item with work keeps the menu open while it runs.
 */
export const ContextMenu = ({
  children,
  onOpenChange,
  disabled = false,
}: ContextMenuProps) => {
  // A long press opened it, and that finger has not come down again since.
  const held = useRef(false);
  const change: OpenChange = (open, details) => {
    const { event, reason } = details;
    if (open) {
      held.current =
        reason === "trigger-press" &&
        event instanceof PointerEvent &&
        event.pointerType === "touch";
      if (held.current) {
        window.addEventListener(
          "pointerdown",
          () => {
            held.current = false;
          },
          { capture: true, once: true }
        );
      }
    } else if (
      held.current &&
      reason === "outside-press" &&
      event?.type === "click"
    ) {
      // The click a browser sends as the finger lifts ends the long press, on the area, not a
      // press outside the menu: inside a dialog or a sheet it was taken for one, and closed the
      // menu as it opened.
      held.current = false;
      details.cancel();
      return;
    }
    onOpenChange?.(open, details);
  };
  return (
    <Menu
      onOpenChange={change}
      // Silent: an item says its own work once it starts, with its own words.
      pendingAnnouncement=""
    >
      <Disabled value={disabled}>{children}</Disabled>
    </Menu>
  );
};

/** The area the menu opens on, with its tab stop and its name. */
export const ContextMenuTrigger = ({
  children,
  "aria-label": ariaLabel,
  asChild = false,
  tabStop = true,
  style,
}: ContextMenuTriggerProps) => {
  const disabled = use(Disabled);
  const slot = slotProps(asChild, children);
  return (
    <MenuContextTrigger
      disabled={disabled}
      tabIndex={disabled || !tabStop ? undefined : 0}
      // The area is any content the caller gives; a <fieldset> would bring its own border and padding.
      // An area with no tab stop only stands round the thing the keys reach, which has the name:
      // it is no group of the same name beside it.
      role={tabStop ? "group" : undefined}
      aria-label={tabStop ? ariaLabel : undefined}
      onKeyDown={disabled ? undefined : openByKey}
      render={slotted("div", "context-menu-trigger", slot.render)}
      {...stylex.props(styles.area, focusRing, style)}
    >
      {slot.children}
    </MenuContextTrigger>
  );
};

/** The menu, at the pointer. */
export const ContextMenuContent = ({
  children,
  finalFocus,
  style,
}: ContextMenuContentProps) => (
  <MenuContent
    finalFocus={finalFocus}
    sideOffset={popup.gap}
    collisionPadding={popup.gutter}
    render={slotted("div", "context-menu-content")}
    {...stylex.props(
      menuMarker,
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
export const ContextMenuShortcut = ({ children }: ContextMenuShortcutProps) => (
  <MenuShortcutPart kind={kind}>{children}</MenuShortcutPart>
);

/** An action in the menu. */
export const ContextMenuItem = (props: ContextMenuItemProps) => (
  <MenuItemPart {...props} kind={kind} shortcut={ContextMenuShortcut} />
);

/** An option that is on or off, with a tick while it is on. */
export const ContextMenuCheckboxItem = (
  props: ContextMenuCheckboxItemProps
) => <MenuCheckboxItemPart {...props} kind={kind} />;

/** A set of options, one of them chosen. */
export const ContextMenuRadioGroup = (props: ContextMenuRadioGroupProps) => (
  <MenuRadioGroupPart {...props} kind={kind} />
);

/** One option of a radio group, with a dot while it is chosen. */
export const ContextMenuRadioItem = (props: ContextMenuRadioItemProps) => (
  <MenuRadioItemPart {...props} kind={kind} />
);

/** A group of items, named by its label. */
export const ContextMenuGroup = (props: ContextMenuGroupProps) => (
  <MenuGroupPart {...props} kind={kind} />
);

/** A group's name, above its items. */
export const ContextMenuLabel = (props: ContextMenuLabelProps) => (
  <MenuLabelPart {...props} kind={kind} />
);

/** A line between groups of items, edge to edge. */
export const ContextMenuSeparator = (props: ContextMenuSeparatorProps) => (
  <MenuSeparatorPart {...props} kind={kind} />
);

/** A submenu: holds its ContextMenuSubTrigger and ContextMenuSubContent. */
export const ContextMenuSub = ({ children }: ContextMenuSubProps) => (
  <MenuSub>{children}</MenuSub>
);

/** The item that opens its submenu, with a chevron pointing the way it opens. */
export const ContextMenuSubTrigger = (props: ContextMenuSubTriggerProps) => (
  <MenuSubTriggerPart {...props} kind={kind} />
);

/** The submenu, beside its trigger. */
export const ContextMenuSubContent = (props: ContextMenuSubContentProps) => (
  <MenuSubContentPart {...props} kind={kind} />
);
