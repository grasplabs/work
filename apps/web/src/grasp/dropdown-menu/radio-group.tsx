// DropdownMenuRadioGroup: options in a dropdown menu (menu.tsx) of which one is chosen, UI SDK's
// MenuRadioGroup. Put a DropdownMenuLabel first to name it, then its DropdownMenuRadioItems.
"use client";

import { MenuRadioGroup as GroupPrimitive } from "@ui-sdk/react/menu";
import type { ComponentProps, ReactNode } from "react";

type GroupPrimitiveProps = ComponentProps<typeof GroupPrimitive>;

/** Every prop a DropdownMenuRadioGroup takes: these, and the rest of UI SDK's MenuRadioGroup. */
export interface DropdownMenuRadioGroupProps extends Omit<
  GroupPrimitiveProps,
  | "children"
  | "className"
  | "style"
  | "render"
  | "value"
  | "defaultValue"
  | "onValueChange"
> {
  /** Its label and its options. */
  children: ReactNode;
  /** The chosen option's value. Pass it with `onValueChange` to keep it in state. */
  value?: string | null;
  /** The option chosen at first, when you do not keep it in state. */
  defaultValue?: string | null;
  /** Runs when another option is chosen; `details.cancel()` keeps the choice as it is. */
  onValueChange?: GroupPrimitiveProps["onValueChange"];
}

/** A set of options, one of them chosen. */
export const DropdownMenuRadioGroup = ({
  children,
  ...rest
}: DropdownMenuRadioGroupProps) => (
  <GroupPrimitive {...rest}>{children}</GroupPrimitive>
);
