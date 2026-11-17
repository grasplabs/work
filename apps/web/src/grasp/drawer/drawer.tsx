// Drawer: a task in a panel that rises from the bottom of the window, from shadcn's
// (registry/bases/base/ui/drawer.tsx, on Vaul), converted from Tailwind to StyleX and rebuilt on UI
// SDK's Drawer, then made Grasp's: a raised panel with the one corner on its top, a grip to drag it
// by, a body that scrolls between a title and actions that stay put, and actions that are Grasp's
// Buttons and show their work. A drag down, Escape or a press on the shade closes it.
//
//   <Drawer>
//     <DrawerTrigger variant="ink">Set a reminder</DrawerTrigger>
//     <DrawerPanel>
//       <DrawerTitle>Set a reminder</DrawerTitle>
//       <DrawerDescription>We will send it to your inbox.</DrawerDescription>
//       <DrawerBody>…</DrawerBody>
//       <DrawerFooter>
//         <DrawerAction>Cancel</DrawerAction>
//         <DrawerAction variant="ink" action={save} workingLabel="Saving" failedLabel="Could not save">Save</DrawerAction>
//       </DrawerFooter>
//     </DrawerPanel>
//   </Drawer>
//
// Every value is a token (src/tokens). A panel along a side is a Sheet (src/components/sheet).
"use client";

import { Drawer as DrawerPrimitive } from "@ui-sdk/react/drawer";
import type {
  DrawerDismissAttemptDetails,
  SnapPoint,
} from "@ui-sdk/react/drawer";
import type { ComponentProps, ReactNode } from "react";

import { useReturnFocus } from "../focus/return-focus";
import { SnapsContext } from "./kind-context";
import { useStill } from "./still-context";

type RootProps = ComponentProps<typeof DrawerPrimitive>;

/** Every prop a Drawer takes: these, and the rest of UI SDK's Drawer. */
export interface DrawerProps extends Omit<
  RootProps,
  | "children"
  | "side"
  | "open"
  | "defaultOpen"
  | "onOpenChange"
  | "dismissible"
  | "onDismissAttempt"
  | "snapPoints"
> {
  /** The trigger and the panel. */
  children: ReactNode;
  /**
   * Open now. Pass it with `onOpenChange` to open and close the drawer yourself. It may be mounted only
   * while open: focus still goes back to what opened it.
   */
  open?: boolean;
  /**
   * Open when the page loads, and focus moves into it.
   * @default false
   */
  defaultOpen?: boolean;
  /** Runs when the drawer wants to open or close; `details.reason` says why, a swipe included. */
  onOpenChange?: RootProps["onOpenChange"];
  /**
   * Whether Escape, a press on the shade and a drag down close it. Pass `false` while a form has
   * unsaved changes, and ask in `onDismissAttempt`. The actions still close it.
   * @default true
   */
  dismissible?: boolean;
  /** Runs when a close was refused: not dismissible, or an action working. */
  onDismissAttempt?: (details: DrawerDismissAttemptDetails) => void;
  /**
   * Heights it can rest at, from the bottom: a fraction of the window, pixels, or `"content"`
   * for its own height. The grip steps through them. Leave it out for one height, its content's.
   */
  snapPoints?: SnapPoint[];
}

/** The root: holds the trigger and the panel, and renders nothing of its own. */
export const Drawer = ({ children, ...rest }: DrawerProps) => {
  const still = useStill();
  const snaps = (rest.snapPoints?.length ?? 0) > 0;
  // Opened by `open` with no trigger: focus goes back to what had it (src/focus/return-focus.ts).
  useReturnFocus(rest.open);
  if (still) {
    return (
      <SnapsContext.Provider value={snaps}>{children}</SnapsContext.Provider>
    );
  }
  return (
    <SnapsContext.Provider value={snaps}>
      <DrawerPrimitive {...rest} side="bottom">
        {children}
      </DrawerPrimitive>
    </SnapsContext.Provider>
  );
};
