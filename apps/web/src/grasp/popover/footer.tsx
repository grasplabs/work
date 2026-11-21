// PopoverFooter: a popover's actions (popover.tsx), at the end of the line.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { popoverStyles as styles } from "./styles";

/** Every prop a PopoverFooter takes. */
export interface PopoverFooterProps {
  /** The actions, the main one last: Cancel, then Send invite. */
  children: ReactNode;
}

/** The actions, at the end of the line. They wrap onto a second line when the panel is narrow. */
export const PopoverFooter = ({ children }: PopoverFooterProps) => (
  <div data-slot="popover-footer" {...stylex.props(styles.footer)}>
    {children}
  </div>
);
