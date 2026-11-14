// DropdownMenuCheckboxItem: an option in a dropdown menu (menu.tsx) that is on or off, UI SDK's
// MenuCheckboxItem in the look of an item, with a tick at the end while it is on. Pressing it
// turns it over and leaves the menu open, so several can be set in one go.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  MenuCheckboxItem as CheckboxPrimitive,
  MenuItemIndicator,
} from "@ui-sdk/react/menu";
import type { MenuCheckboxItemState } from "@ui-sdk/react/menu";
import type { ComponentProps } from "react";

import { Icon, Tick } from "../icons";
import { menuStyles as styles } from "./styles";

type CheckboxPrimitiveProps = ComponentProps<typeof CheckboxPrimitive>;

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the type below, so they cannot drift from what the code accepts.

/** Every prop a DropdownMenuCheckboxItem takes: these, and the rest of UI SDK's MenuCheckboxItem. */
export interface DropdownMenuCheckboxItemProps extends Omit<
  CheckboxPrimitiveProps,
  "children" | "className" | "style" | "render" | "label" | "value"
> {
  /** The words on the option ("Show grid"). Typing its first letters finds it, and an agent presses it by them. */
  children: string;
  /** On now. Pass it with `onCheckedChange` to keep it in state. */
  checked?: boolean;
  /**
   * On at first, when you do not keep it in state.
   * @default false
   */
  defaultChecked?: boolean;
  /** Runs when it wants to turn on or off; `details.cancel()` keeps it as it is. */
  onCheckedChange?: CheckboxPrimitiveProps["onCheckedChange"];
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
}

const className = (...parts: (stylex.StyleXStyles | false)[]) =>
  stylex.props(...parts).className;

/** An option that is on or off, with a tick while it is on. */
export const DropdownMenuCheckboxItem = ({
  children,
  ...rest
}: DropdownMenuCheckboxItemProps) => (
  <CheckboxPrimitive
    {...rest}
    value={children}
    label={children}
    className={(state: MenuCheckboxItemState) =>
      className(
        styles.item,
        state.highlighted && styles.highlighted,
        state.disabled && styles.disabled
      )
    }
  >
    <span {...stylex.props(styles.words)}>{children}</span>
    <MenuItemIndicator {...stylex.props(styles.tick)}>
      <Icon icon={Tick} />
    </MenuItemIndicator>
  </CheckboxPrimitive>
);
