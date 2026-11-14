// Popover: a small task beside the control that opened it, from shadcn's (registry/bases/base/ui/
// popover.tsx, on Base UI, read from shadcn-ui/ui main on 13 November 2026), converted from Tailwind to
// StyleX and rebuilt on UI SDK's Popover, then made Grasp's: a raised panel with the one corner,
// placed beside its trigger and kept inside the window, a title that names it, and actions that are
// Grasp's Buttons and show their work. It never takes the page: the page still scrolls and can be
// pressed, and focus is not trapped.
//
//   <Popover>
//     <PopoverTrigger icon={UserAdd}>Share</PopoverTrigger>
//     <PopoverPanel>
//       <PopoverTitle>Share this report</PopoverTitle>
//       <PopoverDescription>People you add can read it and comment.</PopoverDescription>
//       <Field>…</Field>
//       <PopoverFooter>
//         <PopoverAction>Cancel</PopoverAction>
//         <PopoverAction variant="ink" action={send} workingLabel="Sending"
//           failedLabel="Could not send">Send invite</PopoverAction>
//       </PopoverFooter>
//     </PopoverPanel>
//   </Popover>
//
// Every value is a token (src/tokens).
"use client";

import {
  Popover as PopoverPrimitive,
  createPopoverController,
} from "@ui-sdk/react/popover";
import type {
  PopoverController,
  PopoverDismissReason,
} from "@ui-sdk/react/popover";
import { createContext, useContext, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";

import { useStill } from "./still-context";

type RootProps = ComponentProps<typeof PopoverPrimitive>;
type OpenChangeDetails = Parameters<NonNullable<RootProps["onOpenChange"]>>[1];

/**
 * The popover's controller, for its actions (action.tsx): an action with work closes it when done,
 * and holds it open while the work runs, so a failure is seen where it happened.
 */
interface PopoverWork {
  controller: PopoverController;
  /** Holds the popover open while an action's work runs, and lets it close again. */
  setWorking: (working: boolean) => void;
}
const ControllerContext = createContext<PopoverWork | null>(null);
export const usePopoverController = () => useContext(ControllerContext);

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the type below, so they cannot drift from what the code accepts.

/** Every prop a Popover takes: these, and the rest of UI SDK's Popover. */
export interface PopoverProps extends Omit<
  RootProps,
  "children" | "modal" | "presentation" | "openOnHover" | "delay" | "closeDelay"
> {
  /** The trigger and the panel. */
  children: ReactNode;
  /** Open now. Pass it with `onOpenChange` to open and close the popover yourself. */
  open?: boolean;
  /**
   * Open when the page loads.
   * @default false
   */
  defaultOpen?: boolean;
  /**
   * Runs when the popover wants to open or close; `details.reason` says why, such as
   * `"escape-key"`, `"outside-press"` or `"focus-out"`.
   */
  onOpenChange?: (open: boolean, details: OpenChangeDetails) => void;
  /**
   * Whether Escape, a press outside and Tab out of it close it. Pass `false` while it holds
   * unsaved work, and ask in `onDismissAttempt`. The trigger and the actions still close it.
   * @default true
   */
  dismissible?: boolean;
  /** Runs when Escape or a press outside was refused, because it is not dismissible. */
  onDismissAttempt?: (details: { reason: PopoverDismissReason }) => void;
  /** Opens and closes it from anywhere, and connects a trigger outside it. Make one with `createPopoverController()`. */
  controller?: PopoverController;
}

/** The root: holds the trigger and the panel, and renders nothing of its own. */
export const Popover = ({
  children,
  controller,
  onOpenChange,
  ...rest
}: PopoverProps) => {
  const still = useStill();
  // One of its own when none is passed, so an action can close it once its work is done.
  // oxlint-disable-next-line react/hook-use-state -- made once, never set
  const [own] = useState(() => createPopoverController());
  const working = useRef(false);
  const handle = controller ?? own;
  const work: PopoverWork = {
    controller: handle,
    setWorking: (on: boolean) => {
      working.current = on;
    },
  };
  // While an action works, nothing closes it: Escape, a press outside, Tab out and the trigger wait.
  const change = (open: boolean, details: OpenChangeDetails) => {
    if (!open && working.current) {
      details.cancel();
      return;
    }
    onOpenChange?.(open, details);
  };
  // A still (the docs' drawing of a phase) draws its parts in place, with no popover around them.
  return (
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <ControllerContext.Provider value={work}>
      {still ? (
        children
      ) : (
        <PopoverPrimitive {...rest} onOpenChange={change} controller={handle}>
          {children}
        </PopoverPrimitive>
      )}
    </ControllerContext.Provider>
  );
};
