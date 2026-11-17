// Sheet: a task in a panel along a side of the window, from shadcn's
// (registry/bases/base/ui/sheet.tsx), converted from Tailwind to StyleX and rebuilt on UI SDK's
// Drawer, then made Grasp's: a raised panel the window's height, floating a little off its edges
// as Palermo's drawer does, a head with its title and a close button, a body that scrolls, and actions at its foot
// that are Grasp's Buttons and show their work. Escape, a press on the shade or a drag towards its
// side closes it.
//
//   <Sheet>
//     <SheetTrigger>Edit profile</SheetTrigger>
//     <SheetPanel>
//       <SheetTitle>Edit profile</SheetTitle>
//       <SheetDescription>Your name and role, as the team sees them.</SheetDescription>
//       <SheetBody>…</SheetBody>
//       <SheetFooter>
//         <SheetAction>Cancel</SheetAction>
//         <SheetAction variant="ink" action={save} workingLabel="Saving" failedLabel="Could not save">Save</SheetAction>
//       </SheetFooter>
//     </SheetPanel>
//   </Sheet>
//
// Its parts share Drawer's look and behaviour (src/components/drawer). Every value is a token.
"use client";

import { Drawer as DrawerPrimitive } from "@ui-sdk/react/drawer";
import type { DrawerDismissAttemptDetails } from "@ui-sdk/react/drawer";
import type { ComponentProps, ReactNode } from "react";

import { useStill } from "../drawer/still-context";
import { useReturnFocus } from "../focus/return-focus";
import { SizeContext } from "./size-context";

type RootProps = ComponentProps<typeof DrawerPrimitive>;

/** Every prop a Sheet takes: these, and the rest of UI SDK's Drawer. */
export interface SheetProps extends Omit<
  RootProps,
  | "children"
  | "side"
  | "open"
  | "defaultOpen"
  | "onOpenChange"
  | "dismissible"
  | "onDismissAttempt"
  | "snapPoints"
  | "snapPoint"
  | "defaultSnapPoint"
  | "onSnapPointChange"
> {
  /** The trigger and the panel. */
  children: ReactNode;
  /**
   * The side it stands along: `end` (the right in English) for a task or details, `start` for
   * a list of places to go. Both follow the reading direction.
   * @default "end"
   */
  side?: "start" | "end";
  /**
   * How wide it is: `md` for a form or details, `wide` for a layout of its own, `full` for a chart
   * or a table opened in full. Never closer than its inset to the window's edges.
   * @default "md"
   */
  size?: "md" | "wide" | "full";
  /**
   * Open now. Pass it with `onOpenChange` to open and close the sheet yourself. It may be mounted only
   * while open: focus still goes back to what opened it.
   */
  open?: boolean;
  /**
   * Open when the page loads, and focus moves into it.
   * @default false
   */
  defaultOpen?: boolean;
  /** Runs when the sheet wants to open or close; `details.reason` says why, a swipe included. */
  onOpenChange?: RootProps["onOpenChange"];
  /**
   * Whether Escape, a press on the shade and a drag towards its side close it. Pass `false`
   * while a form has unsaved changes, and ask in `onDismissAttempt`.
   * @default true
   */
  dismissible?: boolean;
  /** Runs when a close was refused: not dismissible, or an action working. */
  onDismissAttempt?: (details: DrawerDismissAttemptDetails) => void;
}

/** The root: holds the trigger and the panel, and renders nothing of its own. */
export const Sheet = ({
  children,
  side = "end",
  size = "md",
  ...rest
}: SheetProps) => {
  const still = useStill();
  // Opened by `open` with no trigger: focus goes back to what had it (src/focus/return-focus.ts).
  useReturnFocus(rest.open);
  if (still) {
    return <SizeContext.Provider value={size}>{children}</SizeContext.Provider>;
  }
  return (
    <SizeContext.Provider value={size}>
      <DrawerPrimitive {...rest} side={side}>
        {children}
      </DrawerPrimitive>
    </SizeContext.Provider>
  );
};
