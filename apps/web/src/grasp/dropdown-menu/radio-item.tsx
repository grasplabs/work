// DropdownMenuRadioItem: one option in a DropdownMenuRadioGroup, UI SDK's MenuRadioItem in the look
// of an item, with a dot at the end while it is the chosen one. Choosing it leaves the menu open.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  MenuItemIndicator,
  MenuRadioItem as RadioPrimitive,
} from "@ui-sdk/react/menu";
import type { MenuRadioItemState } from "@ui-sdk/react/menu";
import type { ComponentProps } from "react";

import { menuStyles as styles } from "./styles";

type RadioPrimitiveProps = ComponentProps<typeof RadioPrimitive>;

/** Every prop a DropdownMenuRadioItem takes: these, and the rest of UI SDK's MenuRadioItem. */
export interface DropdownMenuRadioItemProps extends Omit<
  RadioPrimitiveProps,
  "children" | "className" | "style" | "render" | "label"
> {
  /** The words on the option ("Date modified"). Typing its first letters finds it, and an agent presses it by them. */
  children: string;
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
}

const className = (...parts: (stylex.StyleXStyles | false)[]) =>
  stylex.props(...parts).className;

/** One option of a radio group, with a dot while it is chosen. */
export const DropdownMenuRadioItem = ({
  children,
  ...rest
}: DropdownMenuRadioItemProps) => (
  <RadioPrimitive
    {...rest}
    label={children}
    className={(state: MenuRadioItemState) =>
      className(
        styles.item,
        state.highlighted && styles.highlighted,
        state.disabled && styles.disabled
      )
    }
  >
    <span {...stylex.props(styles.words, styles.wordsBare)}>{children}</span>
    <MenuItemIndicator {...stylex.props(styles.dot)} />
  </RadioPrimitive>
);
