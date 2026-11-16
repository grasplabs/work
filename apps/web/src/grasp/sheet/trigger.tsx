// SheetTrigger: the button that opens a sheet (sheet.tsx). The same as Drawer's trigger.
"use client";

import { DrawerTrigger } from "../drawer/trigger";
import type { DrawerTriggerProps } from "../drawer/trigger";

/** Every prop a SheetTrigger takes: a Grasp Button's look, and the rest of UI SDK's DrawerTrigger. */
export type SheetTriggerProps = DrawerTriggerProps;

/** The button that opens the sheet: a Grasp Button that UI SDK's trigger behaviour drives. */
export const SheetTrigger = (props: SheetTriggerProps) => (
  <DrawerTrigger {...props} />
);
