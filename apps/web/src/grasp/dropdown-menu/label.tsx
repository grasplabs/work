// DropdownMenuLabel: the name of a group in a dropdown menu, UI SDK's MenuGroupLabel: small and
// quiet, at the top of its DropdownMenuGroup or DropdownMenuRadioGroup, which it names.
"use client";

import * as stylex from "@stylexjs/stylex";
import { MenuGroupLabel as LabelPrimitive } from "@ui-sdk/react/menu";

import { menuStyles as styles } from "./styles";

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the type below, so they cannot drift from what the code accepts.

/** Every prop a DropdownMenuLabel takes. */
export interface DropdownMenuLabelProps {
  /** The group's name, in sentence case ("Sort by"). */
  children: string;
}

/** A group's name, above its items. */
export const DropdownMenuLabel = ({ children }: DropdownMenuLabelProps) => (
  <LabelPrimitive {...stylex.props(styles.label)}>{children}</LabelPrimitive>
);
