"use client";

import { Dialog as DialogPrimitive } from "@ui-sdk/react/dialog";
import type {
  DialogDismissAttemptDetails,
  DialogOpenChangeDetails,
} from "@ui-sdk/react/dialog";
import type { ComponentProps, ReactNode } from "react";

import { useReturnFocus } from "../focus/return-focus";
import { SizeContext } from "./size-context";
import { useStill } from "./still-context";

type RootProps = ComponentProps<typeof DialogPrimitive>;

/** Every prop a Dialog takes: these, and the rest of UI SDK's Dialog. */
export interface DialogProps extends Omit<
  RootProps,
  "children" | "presentation"
> {
  /** The trigger and the panel. */
  children: ReactNode;
  /**
   * How wide it is: `md` for a form or a short task, `full` for a chart or a table opened in full.
   * Never wider than the window less its gutters; on a phone, the sheet along the bottom either way.
   * @default "md"
   */
  size?: "md" | "full";
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
export const Dialog = ({ children, size = "md", ...rest }: DialogProps) => {
  const still = useStill();
  // Opened by `open` with no trigger: focus goes back to what had it (src/focus/return-focus.ts).
  useReturnFocus(rest.open);
  if (still) {
    // A provider, so the part is a React element even when the children are a Promise.
    return <SizeContext.Provider value={size}>{children}</SizeContext.Provider>;
  }
  return (
    <SizeContext.Provider value={size}>
      <DialogPrimitive {...rest}>{children}</DialogPrimitive>
    </SizeContext.Provider>
  );
};
