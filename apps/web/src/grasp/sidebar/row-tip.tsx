// A row's full name in a Tooltip, only while the row is too narrow for it (its name is cut with an
// ellipsis): the name is already the link's own, so the tooltip is for the eye and adds nothing to
// what a screen reader hears. It opens as Tooltip does, on a pointer's rest or on focus, at the
// row's end. The trigger is the row's link itself, drawn by `render`.
"use client";

import { mergeProps } from "@ui-sdk/react/primitive";
import {
  Tooltip as TooltipPrimitive,
  TooltipTrigger as TriggerPrimitive,
} from "@ui-sdk/react/tooltip";
import { useRef } from "react";
import type { ReactElement } from "react";

import { ms } from "../tokens/tokens.values";
import { TooltipContent } from "../tooltip";

/** Whether the row's name is cut: its words run past their box. */
const isCut = (row: HTMLElement | null) => {
  const name = row?.querySelector<HTMLElement>("[data-row-name]");
  return (
    name !== null && name !== undefined && name.scrollWidth > name.clientWidth
  );
};

/** The trigger's props without the description: the tooltip repeats the link's own name. */
const withoutDescription = (props: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(props).filter(([key]) => key !== "aria-describedby")
  );

export const RowTip = ({
  label,
  render,
}: {
  label: string;
  render: (props: Record<string, unknown>) => ReactElement;
}) => {
  const node = useRef<HTMLElement | null>(null);
  const keep = (element: HTMLElement | null) => {
    node.current = element;
  };
  const onOpenChange = (open: boolean, details: { cancel: () => void }) => {
    if (open && !isCut(node.current)) {
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
          render(withoutDescription(mergeProps(trigger, { ref: keep })))
        }
      />
      <TooltipContent side="end">{label}</TooltipContent>
    </TooltipPrimitive>
  );
};
