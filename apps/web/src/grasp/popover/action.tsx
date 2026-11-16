// PopoverAction: an action in a popover's footer (popover.tsx), a Grasp Button. It closes the
// popover, after its work when it has some, and shows that work as a Button does (working, then
// failed if it failed). Focus goes back to the trigger when it closes.
"use client";

import { Button as PressPrimitive } from "@ui-sdk/react/button";
import type { ButtonState } from "@ui-sdk/react/button";
import { PopoverClose as ClosePrimitive } from "@ui-sdk/react/popover";
import { useEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";

import { Button } from "../button";
import type { ActionState, ButtonVariant, ButtonWords } from "../button";
import type { IconData } from "../icons";
import { ms } from "../tokens/tokens.values";
import { usePopoverController } from "./popover";
import { useStill } from "./still-context";

type ClosePrimitiveProps = ComponentProps<typeof ClosePrimitive>;

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the type below, so they cannot drift from what the code accepts.

/** What every action takes. */
interface ActionBase extends Omit<
  ClosePrimitiveProps,
  "render" | "children" | "className" | "style" | "onClick"
> {
  /** The words on the action: a verb first ("Send invite"), or "Cancel". */
  children: ButtonWords;
  /**
   * The action is a Button: `quiet` for Cancel, `ink` for the one step the popover is for.
   * @default "quiet"
   */
  variant?: ButtonVariant;
  /** An icon before the words. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /**
   * What the action does, for the person an agent must ask first ("Removes the person"). A
   * `danger` action asks with its own words when this is left out.
   */
  agentConfirm?: string;
}

/** An action that only closes, such as Cancel. */
interface WithoutWork {
  action?: undefined;
  workingLabel?: never;
  failedLabel?: never;
}

/**
 * An action with work to do before the popover closes.
 */
interface WithWork {
  /**
   * The work. Return a Promise and the popover stays open while it runs: the button says it is
   * working and keeps its width. If it fails, the button says so and the popover stays open.
   */
  action: () => unknown;
  /** The words while the work runs ("Sending"). Leave it out to keep the button's own words. */
  workingLabel?: string;
  /** The words when the work failed, said plainly on the button and to a screen reader ("Could not send"). */
  failedLabel: string;
}

/** Every prop a PopoverAction takes: these, and the rest of UI SDK's PopoverClose. */
export type PopoverActionProps = ActionBase & (WithoutWork | WithWork);

/** Who sees a failure: shown on the button for a moment, then the button is ready again. */
const useFailed = (error: unknown) => {
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

type Look = Pick<
  ActionBase,
  "children" | "variant" | "icon" | "agentConfirm"
> & {
  workingLabel?: string | undefined;
  failedLabel?: string | undefined;
};

interface ActionButtonProps {
  props: Record<string, unknown>;
  state: ActionState;
  error: unknown;
  look: Look;
  /** It has work to do, so it shows the work's life: Cancel has none, and keeps its own width. */
  life: boolean;
}

/** What the button shows: working while the work runs, failed for a moment after it failed. */
const currentOf = (state: ActionState, failed: boolean): ActionState => {
  if (state === "working") {
    return "working";
  }
  return failed ? "failed" : "idle";
};

const ActionButton = ({
  props,
  state,
  error,
  look,
  life,
}: ActionButtonProps) => {
  const failed = useFailed(error);
  const {
    variant = "quiet",
    icon,
    children,
    workingLabel,
    failedLabel,
    agentConfirm,
  } = look;
  const words = typeof children === "string" ? children : undefined;
  const confirm = agentConfirm ?? (variant === "danger" ? words : undefined);
  const lifeProps = life
    ? {
        state: currentOf(state, failed),
        workingLabel,
        doneLabel: words ?? "",
        failedLabel: failedLabel ?? "",
      }
    : {};
  return (
    <Button
      {...props}
      {...lifeProps}
      data-agent-confirm={confirm}
      variant={variant}
      icon={icon}
      size="sm"
    >
      {children}
    </Button>
  );
};

interface WorkActionProps {
  rest: Omit<ActionBase, "children" | "variant" | "icon" | "agentConfirm">;
  action: WithWork["action"];
  look: Look;
}

/**
 * Runs an action's work with its popover held open, then closes it. A failure keeps it open and
 * rejects with the failure words, so an agent's press fails with them.
 */
const runWork = async (
  action: WithWork["action"],
  popover: ReturnType<typeof usePopoverController>,
  failedLabel: string | undefined
) => {
  popover?.setWorking(true);
  try {
    await action();
  } catch {
    popover?.setWorking(false);
    throw new Error(failedLabel);
  }
  popover?.setWorking(false);
  popover?.controller.close({ reason: "close-press" });
};

// An action with work: UI SDK's Button, whose press returns the work's Promise, so an agent's press
// waits for the work and a failure fails the step with the failure words. Once the work is done,
// the popover closes as a Close part would, and focus goes back to the trigger. UI SDK settles that
// Promise itself, so a person's failed press reaches the console as nothing.
const WorkAction = ({ rest, action, look }: WorkActionProps) => {
  const popover = usePopoverController();
  const work = async () => {
    await runWork(action, popover, look.failedLabel);
  };
  return (
    <PressPrimitive
      {...rest}
      pendingAnnouncement=""
      onClick={work}
      render={(pressProps: Record<string, unknown>, state: ButtonState) => (
        <ActionButton
          props={pressProps}
          state={state.pending ? "working" : "idle"}
          error={state.error}
          look={look}
          life
        />
      )}
    />
  );
};

/**
 * An action in the footer. It closes the popover, after its work when it has some. Every action
 * closes: a step that keeps the popover open belongs among its fields.
 */
export const PopoverAction = (props: PopoverActionProps) => {
  const {
    children,
    variant,
    icon,
    action,
    workingLabel,
    failedLabel,
    agentConfirm,
    ...rest
  } = props;
  const still = useStill();
  const look = {
    children,
    variant,
    icon,
    workingLabel,
    failedLabel,
    agentConfirm,
  };
  if (still) {
    return (
      <ActionButton
        props={{ type: "button" }}
        state="idle"
        error={undefined}
        look={look}
        life={action !== undefined}
      />
    );
  }
  if (action === undefined) {
    return (
      <ClosePrimitive
        {...rest}
        render={(closeProps: Record<string, unknown>) => (
          <ActionButton
            props={closeProps}
            state="idle"
            error={undefined}
            look={look}
            life={false}
          />
        )}
      />
    );
  }
  return <WorkAction rest={rest} action={action} look={look} />;
};
