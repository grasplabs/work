// DropdownMenuPanel: the panel of a dropdown menu (menu.tsx), UI SDK's MenuContent in Grasp's look.
// It stands menu-gap off its trigger, flips to the other side when there is no room, and shifts to
// stay inside the window, clear of its edges by the gutter. The arrows, Home and End, and typing a
// word move through its items; Escape and a press outside close it, and focus goes back to the
// trigger.
"use client";

import * as stylex from "@stylexjs/stylex";
import { MenuContent as ContentPrimitive } from "@ui-sdk/react/menu";
import type { ComponentProps, ReactNode } from "react";

import { scroll } from "../scroll/scroll";
import { popup } from "../tokens/tokens.values";
import { menuStyles as styles } from "./styles";

type ContentPrimitiveProps = ComponentProps<typeof ContentPrimitive>;

// The gap to the trigger and the room kept from the window's edges reach UI SDK as numbers,
// generated from the menu-gap and popup-gutter tokens (src/tokens/tokens.values.ts).
// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the type below, so they cannot drift from what the code accepts.

/** Every prop a DropdownMenuPanel takes: these, and the rest of UI SDK's MenuContent. */
export interface DropdownMenuPanelProps extends Omit<
  ContentPrimitiveProps,
  | "children"
  | "className"
  | "style"
  | "render"
  | "sideOffset"
  | "collisionPadding"
  | "arrowPadding"
  | "keepMounted"
  | "container"
> {
  /** The items, groups and separators, in the order they are read. */
  children: ReactNode;
  /**
   * The side of the trigger it opens on. It flips to the other side when there is no room.
   * @default "bottom"
   */
  side?: ContentPrimitiveProps["side"];
  /**
   * How it lines up with the trigger: `start` and `end` follow the reading direction. `end` for a
   * trigger at the end of a row or a toolbar.
   * @default "center"
   */
  align?: ContentPrimitiveProps["align"];
  /**
   * Where focus goes when it closes while focus is inside it: back to the trigger by default.
   * @default "trigger"
   */
  finalFocus?: ContentPrimitiveProps["finalFocus"];
}

/** The panel, beside its trigger. */
export const DropdownMenuPanel = ({
  children,
  align = "center",
  ...rest
}: DropdownMenuPanelProps) => (
  <ContentPrimitive
    {...rest}
    align={align}
    sideOffset={popup.menuGap}
    collisionPadding={popup.gutter}
    {...stylex.props(styles.panel, styles.motion, scroll.bar)}
  >
    {children}
  </ContentPrimitive>
);
