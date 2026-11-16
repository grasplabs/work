// DialogDescription: the sentence under a dialog's title (dialog.tsx). It describes the dialog.
"use client";

import * as stylex from "@stylexjs/stylex";
import { DialogDescription as DescriptionPrimitive } from "@ui-sdk/react/dialog";
import type { ReactNode } from "react";

import { useStill } from "./still-context";
import { dialogStyles as styles } from "./styles";

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the type below, so they cannot drift from what the code accepts.

/** Every prop a DialogDescription takes. */
export interface DialogDescriptionProps {
  /** One or two sentences on what happens, read with the title when the dialog opens. */
  children: ReactNode;
}

/** The sentence under the title. It describes the dialog to a screen reader. */
export const DialogDescription = ({ children }: DialogDescriptionProps) => {
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
