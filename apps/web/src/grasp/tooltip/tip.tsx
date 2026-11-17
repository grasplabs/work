// A tooltip on the trigger of a layer (Popover, Dropdown menu, Dialog, Sheet, Drawer): their
// `tooltip` prop. The layer's trigger is drawn inside a Tooltip's trigger, so one Button carries
// both. The tooltip says what the layer is for; it never opens while the layer is open (the trigger
// then says `aria-expanded="true"`), and a press that opens the layer closes it. Loaded only for a
// trigger with a `tooltip` (lazy-tip.tsx), so a plain trigger ships no Tooltip.
"use client";

import { mergeProps } from "@ui-sdk/react/primitive";
import {
  Tooltip as TooltipPrimitive,
  TooltipTrigger as TriggerPrimitive,
} from "@ui-sdk/react/tooltip";
import { useRef } from "react";
import type { ReactElement } from "react";

import { ms } from "../tokens/tokens.values";
import { TooltipPanel } from "./panel";

export interface TipProps {
  /** The tooltip's words. */
  tooltip: string;
  /** Draws the layer's trigger with the tooltip trigger's props merged in. */
  render: (props: Record<string, unknown>) => ReactElement;
}

/** Whether the layer this trigger opens is open now. */
const layerOpen = (element: HTMLElement | null) =>
  element?.getAttribute("aria-expanded") === "true";

export const Tip = ({ tooltip, render }: TipProps) => {
  const node = useRef<HTMLElement | null>(null);
  const keep = (element: HTMLElement | null) => {
    node.current = element;
  };
  // While the layer is open the tooltip would stand over it or beside it: it is stopped before it opens.
  const onOpenChange = (open: boolean, details: { cancel: () => void }) => {
    if (open && layerOpen(node.current)) {
      details.cancel();
    }
  };
  return (
    <TooltipPrimitive
      delay={ms.tooltipDelay}
      type="description"
      onOpenChange={onOpenChange}
    >
      <TriggerPrimitive
        render={(trigger: Record<string, unknown>) =>
          render(mergeProps(trigger, { ref: keep }))
        }
      />
      <TooltipPanel>{tooltip}</TooltipPanel>
    </TooltipPrimitive>
  );
};
