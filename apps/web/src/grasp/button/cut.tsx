// A Button with `truncate`: the button is the trigger of a Tooltip that shows its words whole, and
// opens only while they are cut (an ellipsis shows). Its words stay its name, so the tooltip adds no
// description: a screen reader would hear the name twice. Button loads this file only for a Button
// with `truncate`, so a plain one ships no Tooltip.
//
//   <Button truncate icon={Folder}>Quarterly planning for the platform team</Button>
"use client";

import { mergeProps } from "@ui-sdk/react/primitive";
import {
  Tooltip as TooltipPrimitive,
  TooltipTrigger as TriggerPrimitive,
} from "@ui-sdk/react/tooltip";
import { useRef } from "react";

import { ms } from "../tokens/tokens.values";
import { TooltipContent } from "../tooltip/panel";
import { Button } from "./button";
import type { ButtonProps } from "./button";

/** Whether any of the button's words end in an ellipsis now: read when the tooltip would open. */
const isCut = (element: HTMLElement | null) =>
  element !== null &&
  [...element.querySelectorAll<HTMLElement>("[data-words]")].some(
    (words) => words.scrollWidth > words.clientWidth
  );

export const CutButton = (props: ButtonProps) => {
  const node = useRef<HTMLElement | null>(null);
  const { ref: callerRef, ...rest } = props;
  const keep = (element: HTMLElement | null) => {
    node.current = element;
  };
  // Words that fit need no tooltip: it is stopped before it opens, never shown and then hidden.
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
        render={(trigger: Record<string, unknown>) => {
          // The tooltip only repeats the name, so it is not tied to the button as a description.
          const { "aria-describedby": _repeated, ...own } = trigger;
          // One element takes the trigger's ref, the caller's and this one's; the caller's props win.
          const merged: Record<string, unknown> = mergeProps(
            own,
            rest,
            { ref: callerRef },
            { ref: keep }
          );
          return <Button {...merged} {...rest} />;
        }}
      />
      <TooltipContent>{rest.children}</TooltipContent>
    </TooltipPrimitive>
  );
};
