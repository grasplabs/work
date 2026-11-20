// The Button a closing layer's footer action draws: Dialog's and Alert dialog's
// (src/components/dialog/action.tsx), Drawer's and Sheet's (src/components/drawer/action.tsx) and
// Popover's (src/components/popover/action.tsx). Each layer keeps its own close part and its own
// place for the button; the button, its work's life and the failure it shows for a moment are this
// one. Not exported from the Button entry: it is the layers' own part.
"use client";

import { useEffect, useRef, useState } from "react";

import type { IconData } from "../icons";
import { ms } from "../tokens/tokens.values";
import { useWords } from "../words/words";
import { Button } from "./button";
import type {
  ActionState,
  ButtonLayoutStyle,
  ButtonVariant,
  ButtonWords,
} from "./button";
import { buttonWords } from "./words";
import type { ButtonOwnWords } from "./words";

/** Who sees a failure: shown on the button for a moment, then the button is ready again. */
export const useFailed = (error: unknown) => {
  const [shown, setShown] = useState(false);
  // The failure last shown, boxed, so "none" is not a value the work could have thrown.
  const last = useRef<{ error: unknown } | null>(null);
  useEffect(() => {
    // A press clears the error, so the same failure twice is shown twice.
    let timer = 0;
    if (error === undefined) {
      last.current = null;
    } else if (last.current?.error !== error) {
      last.current = { error };
      setShown(true);
      timer = window.setTimeout(() => {
        setShown(false);
      }, ms.durationHold);
    }
    return () => {
      clearTimeout(timer);
    };
  }, [error]);
  return shown;
};

/** What the button shows: working while the work runs, failed for a moment after it failed. */
export const currentOf = (state: ActionState, failed: boolean): ActionState => {
  if (state === "working") {
    return "working";
  }
  return failed ? "failed" : "idle";
};

/** How an action looks: its words, its variant and icon, and the words of its work's life. */
export interface CloseActionLook {
  children: ButtonWords;
  variant?: ButtonVariant | undefined;
  icon?: IconData | undefined;
  agentConfirm?: string | undefined;
  workingLabel?: string | undefined;
  /** The failure words; left out, Button's catalogue's (`actionFailed`). */
  failedLabel?: string | undefined;
  /** The action's own words, over the catalogue's. */
  words?: Partial<ButtonOwnWords> | undefined;
}

/** A closing action's Button, as a layer's footer draws it. */
export interface CloseActionButtonProps {
  props: Record<string, unknown>;
  state: ActionState;
  error: unknown;
  look: CloseActionLook;
  /** Its place in the footer, layout only, as a Button's style is. Left out, the button keeps the one it is given. */
  place?: ButtonLayoutStyle | undefined;
  /** It has work to do, so it shows the work's life: Cancel has none, and keeps its own width. */
  life: boolean;
}

/** The place, when the layer gives one: never an empty style over the one in `props`. */
const placedFor = (place: ButtonLayoutStyle | undefined) =>
  place === undefined ? {} : { style: place };

export const CloseActionButton = ({
  props,
  state,
  error,
  look,
  place,
  life,
}: CloseActionButtonProps) => {
  const failed = useFailed(error);
  const { actionFailed } = useWords("button", buttonWords, look.words);
  const {
    variant = "quiet",
    icon,
    children,
    workingLabel,
    failedLabel = actionFailed,
    agentConfirm,
  } = look;
  const words = typeof children === "string" ? children : undefined;
  const confirm = agentConfirm ?? (variant === "danger" ? words : undefined);
  const lifeProps = life
    ? {
        state: currentOf(state, failed),
        workingLabel,
        doneLabel: words ?? "",
        failedLabel,
      }
    : {};
  return (
    <Button
      {...props}
      {...lifeProps}
      {...placedFor(place)}
      data-agent-confirm={confirm}
      variant={variant}
      icon={icon}
      size="sm"
    >
      {children}
    </Button>
  );
};

/**
 * Runs an action's work after the press, a moment later, as UI SDK settles it. A failure rejects
 * with the failure words, so an agent's press fails with them.
 */
export const runCloseWork = async (
  action: (event: Event | undefined, details: { source: string }) => unknown,
  event: Event | undefined,
  details: { source: string },
  failedLabel: string | undefined
) => {
  await Promise.resolve();
  try {
    return await action(event, details);
  } catch {
    throw new Error(failedLabel);
  }
};
