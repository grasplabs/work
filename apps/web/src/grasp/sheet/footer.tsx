// SheetFooter: a sheet's footer (sheet.tsx). The same part as DrawerFooter (src/components/drawer/footer.tsx).
"use client";

import { DrawerFooter } from "../drawer/footer";
import type { DrawerFooterProps } from "../drawer/footer";

/** Every prop a SheetFooter takes: the same as DrawerFooter. */
export type SheetFooterProps = DrawerFooterProps;

/** The sheet's footer, as DrawerFooter. */
export const SheetFooter = (props: SheetFooterProps) => (
  <DrawerFooter {...props} />
);
