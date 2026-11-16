// AlertDialogTitle: the question an alert dialog (alert-dialog.tsx) asks. It names the alert dialog.
"use client";

import * as stylex from "@stylexjs/stylex";
import { AlertDialogTitle as TitlePrimitive } from "@ui-sdk/react/alert-dialog";
import type { ReactNode } from "react";

import { useStill } from "../dialog/still-context";
import { dialogStyles } from "../dialog/styles";
import { alertDialogStyles } from "./styles";

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the type below, so they cannot drift from what the code accepts.

/** Every prop an AlertDialogTitle takes. */
export interface AlertDialogTitleProps {
  /** The one question, naming the thing: "Delete Northwind?". It names the alert dialog for a screen reader and an agent. */
  children: ReactNode;
}

/** The question. It names the alert dialog. */
export const AlertDialogTitle = ({ children }: AlertDialogTitleProps) => {
  const still = useStill();
  const look = stylex.props(dialogStyles.title, alertDialogStyles.title);
  if (still) {
    return <div {...look}>{children}</div>;
  }
  return <TitlePrimitive {...look}>{children}</TitlePrimitive>;
};
