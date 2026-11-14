// DropdownMenuSeparator: a hairline between groups of a dropdown menu, UI SDK's MenuSeparator,
// edge to edge of the panel.
"use client";

import * as stylex from "@stylexjs/stylex";
import { MenuSeparator as SeparatorPrimitive } from "@ui-sdk/react/menu";

import { menuStyles as styles } from "./styles";

/** Every prop a DropdownMenuSeparator takes: none. */
export type DropdownMenuSeparatorProps = Record<string, never>;

/** A line between groups of items. */
export const DropdownMenuSeparator = (_props: DropdownMenuSeparatorProps) => (
  <SeparatorPrimitive {...stylex.props(styles.separator)} />
);
