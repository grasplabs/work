// SheetAction: a sheet's action (sheet.tsx). The same part as DrawerAction (src/components/drawer/action.tsx).
"use client";

import { DrawerAction } from "../drawer/action";
import type { DrawerActionProps } from "../drawer/action";

/** Every prop a SheetAction takes: the same as DrawerAction. */
export type SheetActionProps = DrawerActionProps;

/** The sheet's action, as DrawerAction. */
export const SheetAction = (props: SheetActionProps) => (
  <DrawerAction {...props} />
);
