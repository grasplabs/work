// DropdownMenu: a list of actions opened from a button, from shadcn's (registry/bases/base/ui/
// dropdown-menu.tsx, on Base UI), converted from Tailwind to StyleX and rebuilt on UI SDK's Menu,
// then made Grasp's with Palermo's measure: a raised panel beside its trigger, items with an icon,
// words and keys, groups with a label, separators, checkbox and radio items, and a danger item an
// agent must ask about first.
//
//   <DropdownMenu>
//     <DropdownMenuTrigger>Report</DropdownMenuTrigger>
//     <DropdownMenuPanel>
//       <DropdownMenuItem icon={Copy} shortcut="mod+d" onSelect={duplicate}>Duplicate</DropdownMenuItem>
//       <DropdownMenuSeparator />
//       <DropdownMenuItem danger action={remove} failedLabel="Could not delete">Delete</DropdownMenuItem>
//     </DropdownMenuPanel>
//   </DropdownMenu>
//
// Every value is a token (src/tokens).
"use client";

import type { ChangeDetails } from "@ui-sdk/core";
import {
  Menu as MenuPrimitive,
  createMenuController,
} from "@ui-sdk/react/menu";
import type { MenuController, MenuOpenChangeReason } from "@ui-sdk/react/menu";
import { createContext, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * What an item with work (item.tsx) needs from its menu: the controller that closes it once the work
 * is done, and the words a screen reader hears while the work runs.
 */
export interface MenuWork {
  controller: MenuController;
  pendingAnnouncement: string;
  /**
   * Which opening of the menu this is, counted, so work that ends after the menu closed and opened
   * again leaves it open. Read it when the work starts and again when it ends.
   */
  opening: () => number;
}
const WorkContext = createContext<MenuWork | null>(null);
/** Gives the items with work inside a menu what they need: for a root other than DropdownMenu. */
export const MenuWorkProvider = WorkContext.Provider;
export const useMenuWork = () => useContext(WorkContext);

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the type below, so they cannot drift from what the code accepts.

/** Every prop a DropdownMenu takes. */
export interface DropdownMenuProps {
  /** The trigger and the panel. */
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
  onOpenChange?: (
    open: boolean,
    details: ChangeDetails<MenuOpenChangeReason>
  ) => void;
  /**
   * Whether the arrow keys wrap from the last item to the first, and back.
   * @default true
   */
  loop?: boolean;
  /** Opens and closes it from anywhere, and connects a trigger outside it. Make one with `createMenuController()`. */
  controller?: MenuController;
  /**
   * What a screen reader hears once an item's work has run for a second.
   * @default "Working"
   */
  pendingAnnouncement?: string;
}

/** The root: holds the trigger and the panel, and renders nothing of its own. */
export const DropdownMenu = ({
  children,
  controller,
  onOpenChange,
  pendingAnnouncement = "Working",
  ...rest
}: DropdownMenuProps) => {
  // One of its own when none is passed, so an item can close it once its work is done.
  // oxlint-disable-next-line react/hook-use-state -- made once, never set
  const [own] = useState(() => createMenuController());
  const handle = controller ?? own;
  const openings = useRef(0);
  const work: MenuWork = {
    controller: handle,
    pendingAnnouncement,
    opening: () => openings.current,
  };
  const change: DropdownMenuProps["onOpenChange"] = (open, details) => {
    onOpenChange?.(open, details);
    if (open) {
      openings.current += 1;
    }
  };
  return (
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <WorkContext.Provider value={work}>
      <MenuPrimitive
        {...rest}
        onOpenChange={change}
        controller={handle}
        pendingAnnouncement={pendingAnnouncement}
      >
        {children}
      </MenuPrimitive>
    </WorkContext.Provider>
  );
};
