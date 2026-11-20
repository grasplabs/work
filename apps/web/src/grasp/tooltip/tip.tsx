// A tooltip on the trigger of a layer (Popover, Dropdown menu, Dialog, Sheet, Drawer): their
// `tooltip` prop. The layer's trigger is drawn inside a Tooltip's trigger, so one Button carries
// both. The tooltip says what the layer is for; it never opens while the layer is open (the trigger
// then says `aria-expanded="true"`), and a press that opens the layer closes it. Loaded only for a
// trigger with a `tooltip` (lazy-tip.tsx), so a plain trigger ships no Tooltip. With `name` it is an
// icon-only Button's or Toggle's own name, shown; those import it directly (button.tsx, toggle.tsx).
"use client";

import { mergeProps } from "@ui-sdk/react/primitive";
import {
  Tooltip as TooltipPrimitive,
  TooltipTrigger as TriggerPrimitive,
} from "@ui-sdk/react/tooltip";
import { useRef } from "react";
import type { ReactElement } from "react";

import { ms } from "../tokens/tokens.values";
import { TooltipContent } from "./panel";

export interface TipProps {
  /** The tooltip's words. */
  tooltip: string;
  /** Draws the layer's trigger with the tooltip trigger's props merged in. */
  render: (props: Record<string, unknown>) => ReactElement;
  /**
   * Kept but never opened: for a trigger whose tooltip comes and goes with its state (a compact
   * TabsLink's), so the trigger stays the same element and its own transitions run.
   * @default false
   */
  off?: boolean;
  /**
   * The tooltip repeats the trigger's own name (an icon-only Button's `aria-label`, a tab's words),
   * so it adds no `aria-describedby`: a screen reader would hear the name twice.
   * @default false
   */
  name?: boolean;
}

/** Whether a prop is an event handler. */
const isHandler = (value: unknown): value is (...args: unknown[]) => unknown =>
  typeof value === "function";

/**
 * A control's own props with a tooltip trigger's merged in (mergeProps), its press kept whole: the
 * tooltip's press runs first and closes it, then the control's, whose return comes back (an action's
 * Promise, which holds the press while it works and fails an agent's press with its words).
 */
export const withTip = (
  own: Record<string, unknown>,
  tip: Record<string, unknown>
): Record<string, unknown> => {
  const merged: Record<string, unknown> = mergeProps(own, tip);
  // A control another part draws (a menu's trigger) keeps that part's slot, which its selectors read.
  if (typeof own["data-slot"] === "string") {
    merged["data-slot"] = own["data-slot"];
  }
  const press = own.onClick;
  const close = tip.onClick;
  if (isHandler(press) && isHandler(close)) {
    merged.onClick = (...args: unknown[]) => {
      close(...args);
      return press(...args);
    };
  }
  return merged;
};

/** Whether the layer this trigger opens is open now. */
const layerOpen = (element: HTMLElement | null) =>
  element?.getAttribute("aria-expanded") === "true";

/**
 * Whether what this control opens is a layer, over the page (a menu's or a popover's trigger says
 * aria-haspopup), not a disclosure that opens in the page (a group's or a section's toggle), whose
 * name may show while it is open.
 */
const opensLayer = (element: HTMLElement | null) => {
  const popup = element?.getAttribute("aria-haspopup");
  return popup !== null && popup !== undefined && popup !== "false";
};

export const Tip = ({
  tooltip,
  render,
  off = false,
  name = false,
}: TipProps) => {
  const node = useRef<HTMLElement | null>(null);
  const keep = (element: HTMLElement | null) => {
    node.current = element;
  };
  // While the layer is open the tooltip would stand over it or beside it: it is stopped before it opens.
  const onOpenChange = (open: boolean, details: { cancel: () => void }) => {
    // A tip of a control's own name stops only for a layer it opens; an open disclosure keeps it.
    if (
      open &&
      (off || (layerOpen(node.current) && (!name || opensLayer(node.current))))
    ) {
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
        render={(trigger: Record<string, unknown>) => {
          const { "aria-describedby": described, ...own } = trigger;
          // data-tooltip-trigger: a Button drawn here is already a tooltip's, and adds none of its own;
          // "name" when the tooltip only shows the trigger's own name.
          return render(
            mergeProps(own, {
              "aria-describedby": name ? undefined : described,
              "data-tooltip-trigger": name ? "name" : "",
              ref: keep,
            })
          );
        }}
      />
      <TooltipContent>{tooltip}</TooltipContent>
    </TooltipPrimitive>
  );
};
