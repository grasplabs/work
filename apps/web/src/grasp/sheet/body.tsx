// SheetBody: a sheet's body (sheet.tsx). The same part as DrawerBody (src/components/drawer/body.tsx).
"use client";

import { DrawerBody } from "../drawer/body";
import type { DrawerBodyProps } from "../drawer/body";

/** Every prop a SheetBody takes: the same as DrawerBody. */
export type SheetBodyProps = DrawerBodyProps;

/** The sheet's body, as DrawerBody. */
export const SheetBody = (props: SheetBodyProps) => <DrawerBody {...props} />;
