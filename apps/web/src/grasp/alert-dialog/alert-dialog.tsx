// AlertDialog: one question before a grave step that cannot be undone, such as deleting a
// workspace. It says plainly what is lost and offers a safe answer and one action. Built on UI SDK's
// AlertDialog (role="alertdialog") and dressed as Grasp's Dialog (src/components/dialog), whose
// styles it imports, so the two look the same: the raised panel, lift-high, the shade, the motion
// and the sheet under 640px.
//
//   <AlertDialog>
//     <AlertDialogTrigger variant="danger">Delete workspace</AlertDialogTrigger>
//     <AlertDialogPanel>
//       <AlertDialogTitle>Delete Northwind?</AlertDialogTitle>
//       <AlertDialogDescription>Its 12 projects and 340 files are deleted for everyone.</AlertDialogDescription>
//       <AlertDialogFooter>
//         <AlertDialogAction>Keep it</AlertDialogAction>
//         <AlertDialogAction variant="danger" action={remove} workingLabel="Deleting"
//           failedLabel="Could not delete">Delete</AlertDialogAction>
//       </AlertDialogFooter>
//     </AlertDialogPanel>
//   </AlertDialog>
//
// A press on the shade does nothing and there is no close button: the safe answer or Escape is the way out.
// Focus starts on the safe answer, stays inside, and returns to the trigger. Every value is a token.
"use client";

import { AlertDialog as AlertDialogPrimitive } from "@ui-sdk/react/alert-dialog";
import type { AlertDialogOpenChangeReason } from "@ui-sdk/react/alert-dialog";
import type {
  DialogDismissAttemptDetails,
  DialogOpenChangeDetails,
} from "@ui-sdk/react/dialog";
import type { ComponentProps, ReactNode } from "react";

import { useStill } from "../dialog/still-context";
import { useReturnFocus } from "../focus/return-focus";

type RootProps = ComponentProps<typeof AlertDialogPrimitive>;

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the type below, so they cannot drift from what the code accepts.

/** Every prop an AlertDialog takes: these, and the rest of UI SDK's AlertDialog. */
export interface AlertDialogProps extends Omit<RootProps, "children"> {
  /** The trigger and the panel. */
  children: ReactNode;
  /**
   * Open now. Pass it with `onOpenChange` to open and close it yourself. It may be mounted only
   * while open: focus still goes back to what opened it.
   */
  open?: boolean;
  /**
   * Open when the page loads, with focus on the safe answer.
   * @default false
   */
  defaultOpen?: boolean;
  /**
   * Runs when it wants to open or close. `details.reason` says why, and `details.returnValue` is
   * the `value` of the action that closed it.
   */
  onOpenChange?: (
    open: boolean,
    details: DialogOpenChangeDetails<AlertDialogOpenChangeReason>
  ) => void;
  /**
   * Whether Escape cancels it. A press on the shade never does.
   * @default true
   */
  dismissible?: boolean;
  /** Runs when Escape or a press on the shade was refused: the shade, or an action working. */
  onDismissAttempt?: (details: DialogDismissAttemptDetails) => void;
}

/** The root: holds the trigger and the panel, and renders nothing of its own. */
export const AlertDialog = ({ children, ...rest }: AlertDialogProps) => {
  const still = useStill();
  // Opened by `open` with no trigger: focus goes back to what had it (src/focus/return-focus.ts).
  useReturnFocus(rest.open);
  if (still) {
    // A fragment, so the part is a React element even when the children are a Promise.
    // oxlint-disable-next-line react/jsx-no-useless-fragment -- see above
    return <>{children}</>;
  }
  return <AlertDialogPrimitive {...rest}>{children}</AlertDialogPrimitive>;
};
