// Tooltip: a short hint for a control, from shadcn's (registry/bases/base/ui/tooltip.tsx, on Base
// UI), converted from Tailwind to StyleX and rebuilt on UI SDK's Tooltip, then made Grasp's: a
// dark capsule with the one corner, a little off its trigger, with no arrow. It opens when the
// pointer rests on the trigger for tooltip-delay, and at once when keyboard focus reaches it. It
// closes on Escape, when the pointer leaves and when focus moves on. It holds nothing to press.
//
//   <Tooltip shortcut="mod+d">
//     <TooltipTrigger icon={Download} label="Download" variant="ghost" />
//     <TooltipPanel>
//       Download as PDF <TooltipShortcut />
//     </TooltipPanel>
//   </Tooltip>
//
// Every value is a token (src/tokens).
"use client";

import { Tooltip as TooltipPrimitive } from "@ui-sdk/react/tooltip";
import type {
  TooltipController,
  TooltipOpenChangeReason,
} from "@ui-sdk/react/tooltip";
import type { ComponentProps, ReactNode } from "react";

import { ms } from "../tokens/tokens.values";
import { TooltipStillContext, useStill } from "./still-context";
import type { TooltipStillValue } from "./still-context";

type RootProps = ComponentProps<typeof TooltipPrimitive>;

/** Every prop a Tooltip takes: these, and the rest of UI SDK's Tooltip. */
export interface TooltipProps extends Omit<
  RootProps,
  "children" | "type" | "toggleable" | "onOpenChange"
> {
  /** The trigger and the panel. */
  children: ReactNode;
  /** Open now. Pass it with `onOpenChange` to open and close the tooltip yourself. */
  open?: boolean;
  /**
   * Runs when the tooltip wants to open or close; `reason` says why, such as `"trigger-hover"`,
   * `"trigger-focus"` or `"escape-key"`.
   */
  onOpenChange?: (
    open: boolean,
    details: { reason: TooltipOpenChangeReason; cancel: () => void }
  ) => void;
  /**
   * How long the pointer rests on the trigger before it opens, in milliseconds.
   * @default tooltip-delay
   */
  delay?: number;
  /**
   * The keys of what the trigger does, such as `"mod+d"`, shown by `TooltipShortcut`. It names the
   * keys on the trigger (`aria-keyshortcuts`) but does not bind them.
   */
  shortcut?: string;
  /**
   * Stops it from opening. The trigger keeps working.
   * @default false
   */
  disabled?: boolean;
  /** Opens and closes it from anywhere. Make one with `createTooltipController()`. */
  controller?: TooltipController;
}

/** A still drawing's value, with the root's shortcut for a still shortcut to show. */
const withShortcut = (
  still: TooltipStillValue,
  shortcut: string | undefined
): TooltipStillValue => ({ ...still, shortcut });

/** The root: holds the trigger and the panel, and renders nothing of its own. */
export const Tooltip = ({
  children,
  delay = ms.tooltipDelay,
  ...rest
}: TooltipProps) => {
  const still = useStill();
  if (still) {
    // A still drawing: the parts draw themselves, and the shortcut reads its keys from here.
    const value = withShortcut(still, rest.shortcut);
    return (
      <TooltipStillContext.Provider value={value}>
        {children}
      </TooltipStillContext.Provider>
    );
  }
  // It always describes its trigger: an icon-only button keeps its own `label` as its name.
  return (
    <TooltipPrimitive {...rest} delay={delay} type="description">
      {children}
    </TooltipPrimitive>
  );
};
