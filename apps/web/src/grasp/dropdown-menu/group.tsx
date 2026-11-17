// DropdownMenuGroup: items in a dropdown menu (menu.tsx) that belong together, UI SDK's MenuGroup,
// named by the DropdownMenuLabel at its top.
"use client";

import { MenuGroup as GroupPrimitive } from "@ui-sdk/react/menu";
import type { ReactNode } from "react";

/** Every prop a DropdownMenuGroup takes. */
export interface DropdownMenuGroupProps {
  /** A DropdownMenuLabel, then its items. */
  children: ReactNode;
}

/** A group of items, named by its label. */
export const DropdownMenuGroup = ({ children }: DropdownMenuGroupProps) => (
  <GroupPrimitive>{children}</GroupPrimitive>
);
