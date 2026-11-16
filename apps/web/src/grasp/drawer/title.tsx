// DrawerTitle: the title of a drawer (drawer.tsx). It names the drawer.
"use client";

import * as stylex from "@stylexjs/stylex";
import { DrawerTitle as TitlePrimitive } from "@ui-sdk/react/drawer";
import type { ReactNode } from "react";

import { useKind } from "./kind-context";
import { useStill } from "./still-context";
import { drawerStyles as styles } from "./styles";

/** Every prop a DrawerTitle takes. */
export interface DrawerTitleProps {
  /** What the drawer is for, in sentence case: it names it for a screen reader and an agent. */
  children: ReactNode;
  /**
   * Name the panel without drawing a title bar: the words stay for a screen reader, out of sight.
   * For a panel whose own content already heads it (App shell's menu, headed by its sidebar).
   */
  hidden?: boolean;
}

/** The title. It names the drawer. */
export const DrawerTitle = ({ children, hidden = false }: DrawerTitleProps) => {
  const kind = useKind();
  const look = hidden
    ? stylex.props(styles.titleHidden)
    : stylex.props(
        styles.title,
        kind === "drawer" ? styles.titleUnderGrip : styles.titleBesideClose
      );
  if (useStill()) {
    return <h2 {...look}>{children}</h2>;
  }
  return <TitlePrimitive {...look}>{children}</TitlePrimitive>;
};
