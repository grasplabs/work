// Hold to confirm, for a Button with `hold`: the button is the trigger of a small Popover, and its
// press is a hold (use-hold.ts). A full hold runs the action once. Someone who cannot hold (a screen
// reader, a switch, voice control, a quick tap) gets the Popover instead, with the button's own
// words and Cancel. An agent presses that Popover's action, which needs the person's yes.
//
//   <Button variant="danger" hold onClick={deleteDraft}>Delete draft</Button>
//
// The fill is drawn inside the button, clipped to its shape (hold-fill.tsx): it never changes the
// button's size. Button loads this file only for a Button with `hold`, so a plain one ships no Popover.
"use client";

import {
  PopoverClose as ClosePrimitive,
  PopoverTrigger as TriggerPrimitive,
} from "@ui-sdk/react/popover";
import { mergeProps } from "@ui-sdk/react/primitive";
import { isValidElement, useState } from "react";
import type { ReactNode } from "react";

import {
  Popover,
  PopoverAction,
  PopoverFooter,
  PopoverPanel,
  PopoverTitle,
  createPopoverController,
} from "../popover";
import { Button } from "./button";
import type { ButtonProps } from "./button";
import { HoldContext, holdTime, useHold } from "./use-hold";

/** "Delete draft" becomes "delete draft", for "Hold to delete draft". */
const lower = (words: string) => words.charAt(0).toLowerCase() + words.slice(1);

/** The words of a button, however they are written: `Delete {name}` reads "Delete Weekly notes". */
const textOf = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return textOf(node.props.children);
  }
  return "";
};

/** What the confirmation says: the button's words, or its label when it is only an icon. */
const wordsOf = (children: ReactNode, label: string | undefined) => {
  const text = textOf(children).trim();
  if (text !== "") {
    return text;
  }
  return label === "" ? undefined : label;
};

/** A Button with `hold`: the trigger of its confirmation, holding the Button that is pressed. */
export const HoldButton = (props: ButtonProps) => {
  const { hold, onClick, ref: callerRef, ...rest } = props;
  const { variant = "quiet", disabled = false } = rest;
  const words = wordsOf(rest.children, rest.label);
  const busy = rest.state !== undefined && rest.state !== "idle";
  // oxlint-disable-next-line react/hook-use-state -- made once, never set
  const [controller] = useState(() => createPopoverController());
  const pressing = useHold({
    ms: holdTime(hold),
    pressable: !(disabled || busy),
    act: onClick,
    // A hold while the confirmation is open closes it, so its yes cannot run the action again.
    onStart: () => {
      if (controller.isOpen?.()) {
        controller.close();
      }
    },
  });
  const look = {
    holding: pressing.holding,
    ms: pressing.ms,
    name: words === undefined ? undefined : `Hold to ${lower(words)}`,
  };
  // The confirmation's action says the button's own words, in danger for a danger button and in
  // ink otherwise, and an agent always needs the person's yes to press it.
  const confirm =
    variant === "danger" || variant === "approve" ? variant : "ink";
  const said = words ?? "Confirm";
  return (
    <Popover controller={controller}>
      {/* oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled */}
      <HoldContext.Provider value={look}>
        <TriggerPrimitive
          disabled={disabled}
          render={(trigger: Record<string, unknown>) => {
            // The trigger's and the caller's handlers both run, after the hold's own. One element
            // takes the trigger's ref, the caller's and the hold's. The caller's props win over the
            // trigger's, as they would merged; the style is the caller's layout, never merged.
            const merged: Record<string, unknown> = mergeProps(
              trigger,
              rest,
              { ref: callerRef },
              { ref: pressing.ref }
            );
            const own = pressing.handlers(merged);
            return <Button {...merged} {...rest} {...own} />;
          }}
        />
      </HoldContext.Provider>
      <PopoverPanel>
        <PopoverTitle>
          {words === undefined ? "Confirm" : `${words}?`}
        </PopoverTitle>
        <PopoverFooter>
          <PopoverAction>Cancel</PopoverAction>
          {/* It only says yes: the work and its result show on the button, where focus returns. */}
          <ClosePrimitive
            onClick={pressing.handleYes}
            render={(close: Record<string, unknown>) => (
              <Button
                {...close}
                variant={confirm}
                size="sm"
                data-agent-confirm={said}
              >
                {said}
              </Button>
            )}
          />
        </PopoverFooter>
      </PopoverPanel>
    </Popover>
  );
};
