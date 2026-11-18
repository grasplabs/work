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

/**
 * Whether the popover is asked to close because focus went into the Toaster: a toast's action
 * (Undo) pressed while the popover is open. A press there never counts as outside (UI SDK keeps the
 * toast region over every layer), and the focus it takes does not either, so the action runs and
 * the popover stays.
 */
const focusedIntoToaster = (details: OpenChangeDetails) =>
  details.reason === "focus-out" &&
  details.event?.target instanceof Element &&
  details.event.target.closest("[data-slot=toast-region]") !== null;

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
    if (!open && (working.current || focusedIntoToaster(details))) {
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
