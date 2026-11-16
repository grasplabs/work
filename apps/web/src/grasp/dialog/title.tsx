// DialogTitle: the title of a dialog (dialog.tsx), in the serif. It names the dialog.
"use client";

import * as stylex from "@stylexjs/stylex";
import { DialogTitle as TitlePrimitive } from "@ui-sdk/react/dialog";
import type { ReactNode } from "react";

import { useStill } from "./still-context";
import { dialogStyles as styles } from "./styles";

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the type below, so they cannot drift from what the code accepts.

/** Every prop a DialogTitle takes. */
export interface DialogTitleProps {
  /** What the dialog is for, in sentence case: it names the dialog for a screen reader and an agent. */
  children: ReactNode;
}

/** The title, in the serif. It names the dialog. */
export const DialogTitle = ({ children }: DialogTitleProps) => {
  const still = useStill();
  if (still) {
    return <div {...stylex.props(styles.title)}>{children}</div>;
  }
  return (
    <TitlePrimitive {...stylex.props(styles.title)}>{children}</TitlePrimitive>
  );
};
