// PopoverTitle: the title of a popover (popover.tsx). It names the popover.
"use client";

import * as stylex from "@stylexjs/stylex";
import { PopoverTitle as TitlePrimitive } from "@ui-sdk/react/popover";
import type { ReactNode } from "react";

import { useStill } from "./still-context";
import { popoverStyles as styles } from "./styles";

/** Every prop a PopoverTitle takes. */
export interface PopoverTitleProps {
  /** What the popover is for, in sentence case: it names the popover for a screen reader and an agent. */
  children: ReactNode;
}

/** The title. It names the popover. */
export const PopoverTitle = ({ children }: PopoverTitleProps) => {
  const still = useStill();
  if (still) {
    return <div {...stylex.props(styles.title)}>{children}</div>;
  }
  return (
    <TitlePrimitive {...stylex.props(styles.title)}>{children}</TitlePrimitive>
  );
};
