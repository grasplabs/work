// AlertDialogCancel: the safe answer of an alert dialog (alert-dialog.tsx), in the words the
// product gives it (GraspWords, src/words), else "Cancel". It is AlertDialogAction's quiet answer:
// it closes the alert dialog and does nothing else. Put it first in the footer, before the action,
// so focus starts on it.
"use client";

import type { ButtonWords } from "../button";
import { useWords } from "../words/words";
import { AlertDialogAction } from "./action";
import { alertDialogWords } from "./words";

/** Every prop an AlertDialogCancel takes. */
export interface AlertDialogCancelProps {
  /**
   * Words of its own, over the catalogue's (`Keep it`, `Not yet`). Left out, GraspWords gives
   * them, else "Cancel".
   * @default "Cancel"
   */
  children?: ButtonWords;
  /** What `onOpenChange` hears as `details.returnValue` when it closes the alert dialog. */
  value?: string;
}

/** The safe answer: closes the alert dialog, in the catalogue's words unless given its own. */
export const AlertDialogCancel = ({
  children,
  value,
}: AlertDialogCancelProps) => {
  const { cancel } = useWords("alertDialog", alertDialogWords);
  return (
    <AlertDialogAction value={value}>{children ?? cancel}</AlertDialogAction>
  );
};
