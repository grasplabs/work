// PopoverDescription: the sentence under a popover's title (popover.tsx). It describes the popover.
"use client";

import * as stylex from "@stylexjs/stylex";
import { PopoverDescription as DescriptionPrimitive } from "@ui-sdk/react/popover";
import type { ReactNode } from "react";

import { useStill } from "./still-context";
import { popoverStyles as styles } from "./styles";

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the type below, so they cannot drift from what the code accepts.

/** Every prop a PopoverDescription takes. */
export interface PopoverDescriptionProps {
  /** One sentence on what happens, read with the title when focus moves in. */
  children: ReactNode;
}

/** The sentence under the title. It describes the popover to a screen reader. */
export const PopoverDescription = ({ children }: PopoverDescriptionProps) => {
  const still = useStill();
  if (still) {
    return <p {...stylex.props(styles.description)}>{children}</p>;
  }
  return (
    <DescriptionPrimitive {...stylex.props(styles.description)}>
      {children}
    </DescriptionPrimitive>
  );
};
