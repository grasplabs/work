// The model and effort chip's whole words in a Tooltip ("Claude Opus 5.5, Medium"), only while the
// chip is too narrow for them: its name is cut, or its level has left it. The words are
// already the chip's own name, so the tooltip is for the eye and adds nothing a screen reader
// hears. It never opens over the chip's own surface.
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

/** Whether the chip shows less than its words: the name cut, or the level off its line. */
export const isShort = (chip: HTMLElement | null) => {
  const name = chip?.querySelector<HTMLElement>(
    '[data-slot="composer-model-effort-name"]'
  );
  if (name === null || name === undefined) {
    return false;
  }
  const level = chip?.querySelector<HTMLElement>(
    '[data-slot="composer-model-effort-level"]'
  );
  const line = name.getBoundingClientRect();
  // The level has left: gone for want of room (no box), or wrapped off the seen line.
  const levelLeft =
    level !== null &&
    level !== undefined &&
    (level.getClientRects().length === 0 ||
      level.getBoundingClientRect().top >= line.bottom - 0.5);
  return name.scrollWidth > name.clientWidth + 0.5 || levelLeft;
};

/** The trigger's props without the description: the tooltip repeats the chip's own name. */
const withoutDescription = (props: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(props).filter(([key]) => key !== "aria-describedby")
  );

export const ChipTip = ({
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
    if (
      open &&
      (node.current?.getAttribute("aria-expanded") === "true" ||
        !isShort(node.current))
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
        render={(trigger: Record<string, unknown>) =>
          render(withoutDescription(mergeProps(trigger, { ref: keep })))
        }
      />
      <TooltipContent side="top">{label}</TooltipContent>
    </TooltipPrimitive>
  );
};
