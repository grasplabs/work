// ContextMenu: the actions for a thing, opened where it is right-clicked or long-pressed, from
// shadcn's (registry/bases/base/ui/context-menu.tsx, on Base UI), converted from Tailwind to StyleX
// and rebuilt on UI SDK's Menu with its context trigger, then made Grasp's: the popup Select and
// Command share, with Palermo's menu items, a danger tone, and failure words on an action.
//
//   <ContextMenu
//     aria-label="Q3 forecast"
//     items={[
//       { value: "open", label: "Open", icon: ArrowRight },
//       { value: "rename", label: "Rename", shortcut: "f2" },
//       { type: "separator" },
//       { value: "delete", label: "Move to trash", icon: Trash, danger: true },
//     ]}
//     onAction={(value) => run(value)}
//   >
//     <FileRow />
//   </ContextMenu>
//
// The area takes a tab stop, so Shift+F10 or the menu key opens it from the keyboard (with
// `tabStop={false}` the thing inside it that takes the keys does, a row's link). Everything
// in it must also be reachable another way: a context menu is a shortcut, never the only door.
// Every value is a token (src/tokens).
"use client";

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
import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { scroll } from "../scroll/scroll";
import { grasp } from "../tokens/tokens.stylex";
import { popup } from "../tokens/tokens.values";
import { useWords, withGiven } from "../words/words";
import { MenuEntriesView, actionsOf, withFailureWords } from "./menu-items";
import type { MenuEntries } from "./menu-items";
import { contextMenuWords } from "./words";

/** Every prop a ContextMenu takes. */
export interface ContextMenuProps {
  /** The area it opens on: a row, a card, a canvas. It takes a tab stop. */
  children: ReactNode;
  /** The area's name, as a screen reader and an agent say it: the thing the actions are for ("Q3 forecast"). */
  "aria-label": string;
  /** The actions, checkboxes, radio groups, groups and separators, in order. */
  items: MenuEntries;
  /**
   * Runs an action with its value. Return a Promise and the menu stays open while it works; if it
   * throws or rejects, the action shows its `failedLabel`. An agent's press reports the menu's
   * error and reads the same words on the action.
   */
  onAction?: (value: string, details: MenuActionDetails) => unknown;
  /** Runs when a checkbox turns on or off, with its value in `details.value`. */
  onCheckedChange?: (
    checked: boolean,
    details: MenuCheckedChangeDetails
  ) => void;
  /** Runs when a radio group's choice changes, with the group's name in `details.group`. */
  onValueChange?: (value: string, details: MenuValueChangeDetails) => void;
  /**
   * The browser's own menu shows instead, and the area takes no tab stop.
   * @default false
   */
  disabled?: boolean;
  /** What a failed action says when it has no `failedLabel` of its own. @default "Failed" */
  failedLabel?: string;
  /**
   * Whether the area takes a tab stop of its own. `false` when the area holds the thing the keys
   * reach (a row's link): the menu key and Shift+F10 on it still open the menu, as they bubble.
   * @default true
   */
  tabStop?: boolean;
  /**
   * Where focus goes as the menu closes: back to the area by default; an element, a function that
   * finds one (the row's link, when the area takes no tab stop), or `"none"` when the chosen action
   * moves focus itself (a rename field).
   * @default "trigger"
   */
  finalFocus?: ComponentProps<typeof MenuContent>["finalFocus"];
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

export const ContextMenu = ({
  children,
  "aria-label": ariaLabel,
  items,
  onAction,
  onCheckedChange,
  onValueChange,
  disabled = false,
  failedLabel: failedGiven,
  tabStop = true,
  finalFocus,
}: ContextMenuProps) => {
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
