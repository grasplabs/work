"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 6: this file keeps the older shape working beside the parts until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { Menu, MenuContent, MenuContextTrigger } from "@ui-sdk/react/menu";
import type {
  MenuActionDetails,
  MenuCheckedChangeDetails,
  MenuValueChangeDetails,
} from "@ui-sdk/react/menu";
import { useState } from "react";
import type { ComponentProps, KeyboardEvent, ReactNode } from "react";

import { listStyles } from "../combobox/list.styles";
import { MenuLookProvider } from "../dropdown-menu/look";
import { DropdownMenu } from "../dropdown-menu/menu";
import { menuMarker } from "../dropdown-menu/menu.stylex";
import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { scroll } from "../scroll/scroll";
import { grasp } from "../tokens/tokens.stylex";
import { popup } from "../tokens/tokens.values";
import { useWords, withGiven } from "../words/words";
import { contextMenuLook } from "./look";
import { MenuEntriesView, actionsOf, withFailureWords } from "./menu-items";
import type { MenuEntries } from "./menu-items";
import { contextMenuWords } from "./words";

type FinalFocus = ComponentProps<typeof MenuContent>["finalFocus"];

/** Every prop a ContextMenu takes. */
export interface ContextMenuProps {
  /**
   * A ContextMenuTrigger round the area and a ContextMenuContent with its items. In the older
   * shape, with `items`, the area itself.
   */
  children: ReactNode;
  /** @deprecated Use `ContextMenuTrigger.aria-label`. */
  "aria-label"?: string;
  /** @deprecated Use the parts: `ContextMenuContent` holding Dropdown menu's items. */
  items?: MenuEntries;
  /** @deprecated Use `DropdownMenuItem`, with its own `onSelect`, or `action` for work that can fail. */
  onAction?: (value: string, details: MenuActionDetails) => unknown;
  /** @deprecated Use `DropdownMenuCheckboxItem.onCheckedChange`. */
  onCheckedChange?: (
    checked: boolean,
    details: MenuCheckedChangeDetails
  ) => void;
  /** @deprecated Use `DropdownMenuRadioGroup.onValueChange`. */
  onValueChange?: (value: string, details: MenuValueChangeDetails) => void;
  /** @deprecated Use `ContextMenuTrigger.disabled`. */
  disabled?: boolean;
  /** @deprecated Use `DropdownMenuItem`, whose `failedLabel` goes with its `action`. */
  failedLabel?: string;
  /** @deprecated Use `ContextMenuTrigger.tabStop`. */
  tabStop?: boolean;
  /** @deprecated Use `ContextMenuContent.finalFocus`. */
  finalFocus?: FinalFocus;
}

/** Every prop a ContextMenuTrigger takes. */
export interface ContextMenuTriggerProps {
  /** The area it opens on: a row, a card, a canvas. It takes a tab stop. */
  children: ReactNode;
  /** The area's name, as a screen reader and an agent say it: the thing the actions are for ("Q3 forecast"). */
  "aria-label": string;
  /**
   * The browser's own menu shows instead, and the area takes no tab stop.
   * @default false
   */
  disabled?: boolean;
  /**
   * Whether the area takes a tab stop of its own. `false` when the area holds the thing the keys
   * reach (a row's link): the menu key and Shift+F10 on it still open the menu, as they bubble.
   * @default true
   */
  tabStop?: boolean;
}

/** Every prop a ContextMenuContent takes. */
export interface ContextMenuContentProps {
  /**
   * The items: Dropdown menu's DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuRadioGroup
   * with its DropdownMenuRadioItems, DropdownMenuGroup, DropdownMenuLabel and DropdownMenuSeparator.
   */
  children?: ReactNode;
  /**
   * Where focus goes as the menu closes: back to the area by default; an element, a function that
   * finds one (the row's link, when the area takes no tab stop), or `"none"` when the chosen action
   * moves focus itself (a rename field).
   * @default "trigger"
   */
  finalFocus?: FinalFocus;
}

const styles = stylex.create({
  // The area: as it is, with the shared focus ring when the keyboard reaches it.
  area: {
    display: "block",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    WebkitTouchCallout: "none",
  },
});

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

/** The area the menu opens on, with its tab stop and its name. */
export const ContextMenuTrigger = ({
  children,
  "aria-label": ariaLabel,
  disabled = false,
  tabStop = true,
}: ContextMenuTriggerProps) => (
  <MenuContextTrigger
    disabled={disabled}
    tabIndex={disabled || !tabStop ? undefined : 0}
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- the area is any content the caller gives; a <fieldset> would bring its own border and padding
    role="group"
    aria-label={ariaLabel}
    onKeyDown={disabled ? undefined : openByKey}
    {...stylex.props(styles.area, focus.ring)}
  >
    {children}
  </MenuContextTrigger>
);

/** The menu, at the pointer: Dropdown menu's items, drawn in Context menu's look. */
export const ContextMenuContent = ({
  children,
  finalFocus,
}: ContextMenuContentProps) => (
  <MenuLookProvider value={contextMenuLook}>
    <MenuContent
      finalFocus={finalFocus}
      sideOffset={popup.gap}
      collisionPadding={popup.gutter}
      {...stylex.props(
        menuMarker,
        listStyles.popup,
        listStyles.menuPopup,
        scroll.bar
      )}
    >
      {children}
    </MenuContent>
  </MenuLookProvider>
);

// The older shape: the actions as data, the area as the root's children.
const ContextMenuOfItems = ({
  children,
  "aria-label": ariaLabel = "",
  items,
  onAction,
  onCheckedChange,
  onValueChange,
  disabled = false,
  failedLabel: failedGiven,
  tabStop = true,
  finalFocus,
}: ContextMenuProps & { items: MenuEntries }) => {
  const { failed: failedLabel } = withGiven(
    useWords("contextMenu", contextMenuWords),
    { failed: failedGiven }
  );
  // A failure is said aloud by a status line beside the menu, as well as shown on the action.
  const [said, setSaid] = useState("");
  const run = withFailureWords(
    actionsOf(items),
    onAction,
    setSaid,
    failedLabel
  );
  return (
    <Menu
      onAction={run}
      onCheckedChange={onCheckedChange}
      onValueChange={onValueChange}
      pendingAnnouncement="Working"
      loop
    >
      <ContextMenuTrigger
        aria-label={ariaLabel}
        disabled={disabled}
        tabStop={tabStop}
      >
        {children}
      </ContextMenuTrigger>
      <MenuContent
        finalFocus={finalFocus}
        sideOffset={popup.gap}
        collisionPadding={popup.gutter}
        {...stylex.props(listStyles.popup, listStyles.menuPopup, scroll.bar)}
      >
        <MenuEntriesView items={items} failedLabel={failedLabel} />
      </MenuContent>
      <div
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not every screen reader treats <output> as a live region; role="status" is
        role="status"
        {...stylex.props(visuallyHidden)}
      >
        {said}
      </div>
    </Menu>
  );
};

/**
 * The root: holds a ContextMenuTrigger and a ContextMenuContent, and renders nothing of its own. An
 * item with work keeps the menu open while it runs, as in Dropdown menu.
 */
export const ContextMenu = (props: ContextMenuProps) => {
  if (props.items !== undefined) {
    return <ContextMenuOfItems {...props} items={props.items} />;
  }
  return <DropdownMenu>{props.children}</DropdownMenu>;
};
