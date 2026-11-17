// DialogFooter: a dialog's actions (dialog.tsx), at the end of the line.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { useStill } from "./still-context";
import { dialogStyles as styles } from "./styles";

/** Every prop a DialogFooter takes. */
export interface DialogFooterProps {
  /** The actions, the main one last: Cancel, then Rename. */
  children: ReactNode;
}

/** The actions, at the end of the line. On a phone they share its width. */
export const DialogFooter = ({ children }: DialogFooterProps) => {
  const still = useStill();
  return (
    <div
      data-slot="dialog-footer"
      {...stylex.props(styles.footer, still?.look.footer)}
    >
      {children}
    </div>
  );
};
