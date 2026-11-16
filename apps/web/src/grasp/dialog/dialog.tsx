// Dialog: a focused task over the page, from shadcn's (registry/bases/base/ui/dialog.tsx, on Base
// UI, at shadcn-ui/ui c257f688, 4 September 2026), converted from Tailwind to StyleX and rebuilt on
// UI SDK's Dialog, then made Grasp's: a raised panel with the one corner, a title in the serif, a
// body that scrolls between a title and actions that stay put, and actions that are Grasp's
// Buttons and show their work. Under 640px it is a sheet along the bottom of the window.
//
//   <Dialog>
//     <DialogTrigger variant="ink">Rename project</DialogTrigger>
//     <DialogPanel>
//       <DialogTitle>Rename project</DialogTitle>
//       <DialogDescription>Everyone in the workspace sees the new name.</DialogDescription>
//       <DialogBody>…</DialogBody>
//       <DialogFooter>
//         <DialogAction>Cancel</DialogAction>
//         <DialogAction variant="ink" action={rename} workingLabel="Renaming"
//           failedLabel="Could not rename">Rename</DialogAction>
//       </DialogFooter>
//     </DialogPanel>
//   </Dialog>
//
// The shade and the close button come with the panel. An action whose `action` returns a Promise
// keeps the dialog open while it works: the button says so, and Escape, the shade and the close
// button wait. Every value is a token (src/tokens).
"use client";

import { Dialog as DialogPrimitive } from "@ui-sdk/react/dialog";
import type {
  DialogDismissAttemptDetails,
  DialogOpenChangeDetails,
} from "@ui-sdk/react/dialog";
import type { ComponentProps, ReactNode } from "react";

import { useReturnFocus } from "../focus/return-focus";
import { useStill } from "./still-context";

type RootProps = ComponentProps<typeof DialogPrimitive>;

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the type below, so they cannot drift from what the code accepts.

/** Every prop a Dialog takes: these, and the rest of UI SDK's Dialog. */
export interface DialogProps extends Omit<
  RootProps,
  "children" | "presentation"
> {
  /** The trigger and the panel. */
  children: ReactNode;
  /**
   * Open now. Pass it with `onOpenChange` to open and close the dialog yourself. It may be mounted only
   * while open: focus still goes back to what opened it.
   */
  open?: boolean;
  /**
   * Open when the page loads, and focus moves into it.
   * @default false
   */
  defaultOpen?: boolean;
  /** Runs when the dialog wants to open or close; `details.reason` says why. */
  onOpenChange?: (open: boolean, details: DialogOpenChangeDetails) => void;
  /**
   * Whether Escape and a press on the shade close it. Pass `false` while a form has unsaved
   * changes, and ask in `onDismissAttempt`. The close button and the actions still close it.
   * @default true
   */
  dismissible?: boolean;
  /** Runs when Escape or a press on the shade was refused: not dismissible, or an action working. */
  onDismissAttempt?: (details: DialogDismissAttemptDetails) => void;
}

/** The root: holds the trigger and the panel, and renders nothing of its own. */
export const Dialog = ({ children, ...rest }: DialogProps) => {
  const still = useStill();
  // Opened by `open` with no trigger: focus goes back to what had it (src/focus/return-focus.ts).
  useReturnFocus(rest.open);
  if (still) {
    // A fragment, so the part is a React element even when the children are a Promise.
    // oxlint-disable-next-line react/jsx-no-useless-fragment -- see above
    return <>{children}</>;
  }
  return <DialogPrimitive {...rest}>{children}</DialogPrimitive>;
};
