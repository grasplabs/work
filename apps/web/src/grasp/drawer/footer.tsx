// DrawerFooter: a drawer's actions (drawer.tsx), at the end of the line.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { useKind, useSnaps } from "./kind-context";
import { drawerStyles as styles } from "./styles";

/** Every prop a DrawerFooter takes. */
export interface DrawerFooterProps {
  /** The actions, the main one last: Cancel, then Save. */
  children: ReactNode;
}

/** The actions, at the end of the line. On a phone they share its width. At a lower rest they stay in view. */
export const DrawerFooter = ({ children }: DrawerFooterProps) => {
  const kind = useKind();
  const snaps = useSnaps();
  return (
    <div
      data-slot="drawer-footer"
      {...stylex.props(
        styles.footer,
        kind === "sheet" && styles.footerAtFoot,
        kind === "drawer" && snaps && styles.footerRests
      )}
    >
      {children}
    </div>
  );
};
