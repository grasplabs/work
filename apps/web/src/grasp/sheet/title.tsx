// SheetTitle: a sheet's title (sheet.tsx). The same part as DrawerTitle (src/components/drawer/title.tsx).
"use client";

import { DrawerTitle } from "../drawer/title";
import type { DrawerTitleProps } from "../drawer/title";

/** Every prop a SheetTitle takes: the same as DrawerTitle. */
export type SheetTitleProps = DrawerTitleProps;

/** The sheet's title, as DrawerTitle. */
export const SheetTitle = (props: SheetTitleProps) => (
  <DrawerTitle {...props} />
);
