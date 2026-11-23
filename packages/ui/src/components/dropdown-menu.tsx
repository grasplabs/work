// DropdownMenu: a list of actions on one thing, opened from a button, in StyleX, built on UI
// SDK's Menu: a raised panel beside its trigger, items with an icon, words and keys, groups with a
// label, separators, checkbox and radio items, submenus, and an item whose work can fail.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <DropdownMenu>
//     <DropdownMenuTrigger asChild>
//       <Button variant="outline">Report</Button>
//     </DropdownMenuTrigger>
//     <DropdownMenuContent>
//       <DropdownMenuItem icon={CopyIcon} onSelect={duplicate}>
//         Duplicate <DropdownMenuShortcut>mod+d</DropdownMenuShortcut>
//       </DropdownMenuItem>
//       <DropdownMenuSeparator />
//       <DropdownMenuItem variant="destructive" onSelect={remove} errorLabel="Could not delete">
//         Delete
//       </DropdownMenuItem>
//     </DropdownMenuContent>
//   </DropdownMenu>
//
// Enter, Space and the down arrow on the trigger open it on the first item, the up arrow on the
// last; the arrows, Home and End and typing a word move through it; Escape and a press outside
// close it, and focus goes back to the trigger.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { MenuCheckboxItem, MenuRadioGroup } from "@ui-sdk/react/menu";
import { Menu, MenuContent, MenuSub, MenuTrigger } from "@ui-sdk/react/menu";
import { createElement } from "react";
import type { ComponentProps, ReactElement, ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import { EllipsisIcon, Icon } from "../lib/icons";
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
import { menuStyles, scrollbarHidden } from "../lib/styles";
import { popup } from "../lib/tokens.values";
import { slotProps, slotted } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { menuMarker } from "../lib/vars.stylex";
import { Button } from "./button";

type OpenChange = ComponentProps<typeof Menu>["onOpenChange"];
type Side = ComponentProps<typeof MenuContent>["side"];
type Align = ComponentProps<typeof MenuContent>["align"];
type FinalFocus = ComponentProps<typeof MenuContent>["finalFocus"];
type CheckedChange = ComponentProps<typeof MenuCheckboxItem>["onCheckedChange"];
type ValueChange = ComponentProps<typeof MenuRadioGroup>["onValueChange"];

// Every prop is documented once, here; the props on the docs page are read from these types.

/** Every prop a DropdownMenu takes. */
export interface DropdownMenuProps {
  /** A DropdownMenuTrigger and a DropdownMenuContent with its items. */
  children: ReactNode;
  /** Open now. Pass it with `onOpenChange` to open and close the menu yourself. */
  open?: boolean;
  /**
   * Open when the page loads.
   * @default false
   */
  defaultOpen?: boolean;
  /**
   * Runs when the menu wants to open or close; `details.reason` says why, such as
   * `"item-press"`, `"escape-key"` or `"outside-press"`, and `details.cancel()` keeps it as it is.
   */
  onOpenChange?: OpenChange;
  /**
   * Whether the arrow keys wrap from the last item to the first, and back.
   * @default true
   */
  loop?: boolean;
}

/** Every prop a DropdownMenuTrigger takes. */
export interface DropdownMenuTriggerProps {
  /** The trigger's words; with `asChild`, the one element that is the trigger, most often a Button. */
  children: ReactNode;
  /**
   * Draws the one element given as the child as the trigger, with the trigger's props on it.
   * @default false
   */
  asChild?: boolean;
  /**
   * Out of use: it does not open the menu.
   * @default false
   */
  disabled?: boolean;
  /** The trigger's name, when its words do not say it (an icon only). */
  "aria-label"?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a DropdownMenuContent takes. */
export interface DropdownMenuContentProps {
  /** The items, groups, labels, separators and submenus, in the order they are read. */
  children?: ReactNode;
  /**
   * The side of the trigger it opens on. It flips to the other side when there is no room.
   * @default "bottom"
   */
  side?: Side;
  /**
   * How it lines up with the trigger: `start` and `end` follow the reading direction. `end` for a
   * trigger at the end of a row or a toolbar.
   * @default "center"
   */
  align?: Align;
  /**
   * Where focus goes as the menu closes while focus is inside it: back to the trigger by default;
   * `"none"` when the chosen action moves focus itself.
   * @default "trigger"
   */
  finalFocus?: FinalFocus;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a DropdownMenuItem takes. */
export interface DropdownMenuItemProps {
  /**
   * The words, a verb first ("Duplicate"), and a DropdownMenuShortcut at the end when the action
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

/** Every prop a DropdownMenuCheckboxItem takes. */
export interface DropdownMenuCheckboxItemProps {
  /** The words on the option ("Show the grid"). */
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

/** Every prop a DropdownMenuRadioGroup takes. */
export interface DropdownMenuRadioGroupProps {
  /** A DropdownMenuLabel, then its DropdownMenuRadioItems. */
  children: ReactNode;
  /** The chosen option's value, with `onValueChange`: the page holds it. */
  value?: string | null;
  /** Runs when another option is chosen; `details.cancel()` keeps the choice as it is. */
  onValueChange?: ValueChange;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a DropdownMenuRadioItem takes. */
export interface DropdownMenuRadioItemProps {
  /** The words on the option ("Date modified"). */
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

/** Every prop a DropdownMenuGroup takes. */
export interface DropdownMenuGroupProps {
  /** A DropdownMenuLabel, then its items. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a DropdownMenuLabel takes. */
export interface DropdownMenuLabelProps {
  /** The group's name, in sentence case ("Sort by"). */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a DropdownMenuSeparator takes. */
export interface DropdownMenuSeparatorProps {
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a DropdownMenuShortcut takes. */
export interface DropdownMenuShortcutProps {
  /**
   * The keys that do the same elsewhere on the page, like `"mod+d"`: shown as ⌘D on a Mac and
   * Ctrl+D elsewhere, and named to a screen reader on its item. It shows the keys; binding them is
   * the page's.
   */
  children: string;
}

/** Every prop a DropdownMenuSub takes. */
export interface DropdownMenuSubProps {
  /** A DropdownMenuSubTrigger and its DropdownMenuSubContent. */
  children: ReactNode;
}

/** Every prop a DropdownMenuSubTrigger takes. */
export interface DropdownMenuSubTriggerProps {
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

/** Every prop a DropdownMenuSubContent takes. */
export interface DropdownMenuSubContentProps {
  /** The submenu's items. */
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** One action of a DropdownMenuMore: an item of its menu. */
export interface DropdownMenuMoreItem {
  /** Its words ("Rename", "Duplicate"). */
  label: string;
  /** Runs when it is chosen. */
  onSelect?: () => void;
  /** An icon before the words. */
  icon?: IconData;
  /**
   * `destructive` for a step that cannot be undone, in the destructive colour.
   * @default "default"
   */
  variant?: "default" | "destructive";
  /** Shown, but not chosen now. */
  disabled?: boolean;
  /** Where it leads ("Settings"): the item is then an `<a href>`. */
  href?: string;
  /**
   * The link a router draws (`<Link to="…" />`), in place of an `<a href>`: it takes the item's
   * look, words and place in the arrows' order.
   */
  render?: ReactElement<Record<string, unknown>>;
}

/** Every prop a DropdownMenuMore takes. */
export interface DropdownMenuMoreProps {
  /** The actions, in order. */
  items: readonly DropdownMenuMoreItem[];
  /**
   * The button's name.
   * @default "More actions"
   */
  "aria-label"?: string;
  /**
   * The button's size, an icon-only Button's.
   * @default "icon-sm"
   */
  size?: "icon-xs" | "icon-sm" | "icon" | "icon-lg";
  /** Layout only. */
  style?: LayoutStyle;
}

const kind: MenuKind = "dropdown-menu";

/** The root: holds a DropdownMenuTrigger and a DropdownMenuContent, and renders nothing of its own. */
export const DropdownMenu = ({
  children,
  open,
  defaultOpen,
  onOpenChange,
  loop,
}: DropdownMenuProps) => (
  <Menu
    open={open}
    defaultOpen={defaultOpen}
    onOpenChange={onOpenChange}
    loop={loop}
    // Silent: an item says its own work once it starts, with its own words.
    pendingAnnouncement=""
  >
    {children}
  </Menu>
);

/** The control that opens the menu. It says whether it is open (`aria-expanded`). */
export const DropdownMenuTrigger = ({
  children,
  asChild = false,
  disabled,
  "aria-label": ariaLabel,
  style,
}: DropdownMenuTriggerProps) => {
  const slot = slotProps(asChild, children);
  return (
    <MenuTrigger
      disabled={disabled}
      aria-label={ariaLabel}
      render={slotted("button", "dropdown-menu-trigger", slot.render)}
      {...stylex.props(style)}
    >
      {slot.children}
    </MenuTrigger>
  );
};

/** The panel, beside its trigger. */
export const DropdownMenuContent = ({
  children,
  side,
  align = "center",
  finalFocus,
  style,
}: DropdownMenuContentProps) => (
  <MenuContent
    side={side}
    align={align}
    finalFocus={finalFocus}
    sideOffset={popup.menuGap}
    collisionPadding={popup.gutter}
    render={slotted("div", "dropdown-menu-content")}
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
export const DropdownMenuShortcut = ({
  children,
}: DropdownMenuShortcutProps) => (
  <MenuShortcutPart kind={kind}>{children}</MenuShortcutPart>
);

/** An action in the menu. */
export const DropdownMenuItem = (props: DropdownMenuItemProps) => (
  <MenuItemPart {...props} kind={kind} shortcut={DropdownMenuShortcut} />
);

/** An option that is on or off, with a tick while it is on. */
export const DropdownMenuCheckboxItem = (
  props: DropdownMenuCheckboxItemProps
) => <MenuCheckboxItemPart {...props} kind={kind} />;

/** A set of options, one of them chosen. */
export const DropdownMenuRadioGroup = (props: DropdownMenuRadioGroupProps) => (
  <MenuRadioGroupPart {...props} kind={kind} />
);

/** One option of a radio group, with a dot while it is chosen. */
export const DropdownMenuRadioItem = (props: DropdownMenuRadioItemProps) => (
  <MenuRadioItemPart {...props} kind={kind} />
);

/** A group of items, named by its label. */
export const DropdownMenuGroup = (props: DropdownMenuGroupProps) => (
  <MenuGroupPart {...props} kind={kind} />
);

/** A group's name, above its items. */
export const DropdownMenuLabel = (props: DropdownMenuLabelProps) => (
  <MenuLabelPart {...props} kind={kind} />
);

/** A line between groups of items, edge to edge. */
export const DropdownMenuSeparator = (props: DropdownMenuSeparatorProps) => (
  <MenuSeparatorPart {...props} kind={kind} />
);

/** A submenu: holds its DropdownMenuSubTrigger and DropdownMenuSubContent. */
export const DropdownMenuSub = ({ children }: DropdownMenuSubProps) => (
  <MenuSub>{children}</MenuSub>
);

/** The item that opens its submenu, with a chevron pointing the way it opens. */
export const DropdownMenuSubTrigger = (props: DropdownMenuSubTriggerProps) => (
  <MenuSubTriggerPart {...props} kind={kind} />
);

/** The submenu, beside its trigger. */
export const DropdownMenuSubContent = (props: DropdownMenuSubContentProps) => (
  <MenuSubContentPart {...props} kind={kind} />
);

/** What a More menu's action leads to, holding its words: a router's link, an `<a href>`, or none. */
const linkOf = (item: DropdownMenuMoreItem) => {
  if (item.render !== undefined) {
    return createElement(item.render.type, item.render.props, item.label);
  }
  return item.href === undefined || item.href === "" ? undefined : (
    <a href={item.href}>{item.label}</a>
  );
};

/** One action of a More menu: a link when it leads somewhere, else an item. */
const MoreItem = ({ item }: { item: DropdownMenuMoreItem }) => {
  const link = linkOf(item);
  return (
    <DropdownMenuItem
      asChild={link !== undefined}
      icon={item.icon}
      variant={item.variant}
      disabled={item.disabled}
      onSelect={() => {
        item.onSelect?.();
      }}
    >
      {link ?? item.label}
    </DropdownMenuItem>
  );
};

/** A "More" button (an ellipsis) and its menu of actions, in order. */
export const DropdownMenuMore = ({
  items,
  "aria-label": ariaLabel,
  size = "icon-sm",
  style,
}: DropdownMenuMoreProps) => {
  const { dropdownMenu } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={size}
          aria-label={ariaLabel ?? dropdownMenu.expand}
          style={style}
          data-slot="dropdown-menu-more"
        >
          <Icon icon={EllipsisIcon} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((item, index) => (
          // The items have no id of their own, and two may say the same words: their place is it.
          <MoreItem key={index} item={item} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
