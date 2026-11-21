// SheetDescription: a sheet's description (sheet.tsx). The same part as DrawerDescription (src/components/drawer/description.tsx).
"use client";

import { DrawerDescription } from "../drawer/description";
import type { DrawerDescriptionProps } from "../drawer/description";

/** Every prop a SheetDescription takes: the same as DrawerDescription. */
export type SheetDescriptionProps = DrawerDescriptionProps;

/** The sheet's description, as DrawerDescription. */
export const SheetDescription = (props: SheetDescriptionProps) => (
  <DrawerDescription {...props} />
);
