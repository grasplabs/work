// DrawerDescription: the sentence under a drawer's title (drawer.tsx). It describes the drawer.
"use client";

import * as stylex from "@stylexjs/stylex";
import { DrawerDescription as DescriptionPrimitive } from "@ui-sdk/react/drawer";
import type { ReactNode } from "react";

import { useKind } from "./kind-context";
import { useStill } from "./still-context";
import { drawerStyles as styles } from "./styles";

/** Every prop a DrawerDescription takes. */
export interface DrawerDescriptionProps {
  /** One or two sentences on what happens, read with the title when it opens. */
  children: ReactNode;
}

/** The sentence under the title. It describes the drawer to a screen reader. */
export const DrawerDescription = ({ children }: DrawerDescriptionProps) => {
  const kind = useKind();
  const look = stylex.props(
    styles.description,
    kind === "sheet" && styles.descriptionUnderHead
  );
  if (useStill()) {
    return <p {...look}>{children}</p>;
  }
  return <DescriptionPrimitive {...look}>{children}</DescriptionPrimitive>;
};
