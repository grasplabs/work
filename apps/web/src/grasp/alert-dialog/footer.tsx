// AlertDialogFooter: an alert dialog's two answers (alert-dialog.tsx), the safe answer first and the action
// last, at the end of the line. The same footer as Dialog's (src/components/dialog/footer.tsx).
"use client";

import type { ReactNode } from "react";

import { DialogFooter } from "../dialog/footer";

/** Every prop an AlertDialogFooter takes. */
export interface AlertDialogFooterProps {
  /** The safe answer (Keep it), then the one action. The safe answer comes first, so focus starts on it. */
  children: ReactNode;
}

/** The answers, at the end of the line. On a phone they share its width. */
export const AlertDialogFooter = ({ children }: AlertDialogFooterProps) => (
  <DialogFooter>{children}</DialogFooter>
);
