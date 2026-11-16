// AlertDialogAction: one of an alert dialog's two answers (alert-dialog.tsx), the safe answer or the action,
// a Grasp Button that UI SDK's AlertDialogClose drives. It closes the alert dialog, after its work
// when it has some, and shows that work as Dialog's action does (working, then failed if it
// failed), drawn by Dialog's own ActionButton (src/components/dialog/action.tsx).
"use client";

import { AlertDialogClose as ClosePrimitive } from "@ui-sdk/react/alert-dialog";
import type { AlertDialogCloseState } from "@ui-sdk/react/alert-dialog";
import { Button as PressPrimitive } from "@ui-sdk/react/button";
import { useRef } from "react";
import type { ComponentProps, MouseEvent } from "react";

import type { ButtonVariant, ButtonWords } from "../button";
import { ActionButton, runWork } from "../dialog/action";
import type { ActionButtonProps } from "../dialog/action";
import { useStill } from "../dialog/still-context";
import type { IconData } from "../icons";

type ClosePrimitiveProps = ComponentProps<typeof ClosePrimitive>;

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the type below, so they cannot drift from what the code accepts.

/** What every answer takes. */
interface ActionBase extends Omit<
  ClosePrimitiveProps,
  "render" | "children" | "className" | "style" | "action"
> {
  /**
   * The words: the safe answer, what stays ("Keep it", "Not yet"), or the action's verb ("Delete"). Keep the action's
   * words apart from the trigger's, so an agent asked to press one never finds the other.
   */
  children: ButtonWords;
  /**
   * The answer is a Button: `quiet` for the safe answer, `danger` when it deletes, `ink` when it is grave
   * but deletes nothing.
   * @default "quiet"
   */
  variant?: ButtonVariant;
  /** An icon before the words. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /**
   * What the action does, for the person an agent must ask first ("Deletes the workspace
   * Northwind"). Every answer but a `quiet` one, such as Keep it, asks: with its own words when
   * this is left out.
   */
  agentConfirm?: string;
  /** What `onOpenChange` hears as `details.returnValue` when this answer closes it ("confirm"). */
  value?: string;
}

/** An answer that only closes, such as Keep it. */
interface WithoutWork {
  action?: undefined;
  workingLabel?: never;
  failedLabel?: never;
}

/**
 * An answer with work to do before the alert dialog closes.
 */
interface WithWork {
  /**
   * The work. Return a Promise and the alert dialog stays open while it runs, and Escape waits:
   * the button says it is working and keeps its width. If it fails, the button says so and the
   * alert dialog stays open.
   */
  action: (event: Event | undefined, details: { source: string }) => unknown;
  /** The words while the work runs ("Deleting"). Leave it out to keep the button's own words. */
  workingLabel?: string;
  /** The words when the work failed, said plainly on the button, to a screen reader and to an agent ("Could not delete"). */
  failedLabel: string;
}

/** Every prop an AlertDialogAction takes: these, and the rest of UI SDK's AlertDialogClose. */
export type AlertDialogActionProps = ActionBase & (WithoutWork | WithWork);

interface LiveActionProps {
  rest: Omit<ActionBase, "children" | "variant" | "icon" | "agentConfirm">;
  action: WithWork["action"] | undefined;
  look: ActionButtonProps["look"];
}

// The live answer, as Dialog's. With work, the press goes through UI SDK's Button as well as its
// AlertDialogClose: the Button's press returns the work's Promise, so an agent's press waits for
// the work, and a failure fails the step with the failure words. UI SDK settles that Promise
// itself, so a person's failed press reaches the console as nothing.
const LiveAction = ({ rest, action, look }: LiveActionProps) => {
  const running = useRef<Promise<unknown> | null>(null);
  if (action === undefined) {
    return (
      <ClosePrimitive
        {...rest}
        render={(
          props: Record<string, unknown>,
          state: AlertDialogCloseState
        ) => (
          <ActionButton
            props={props}
            state="idle"
            error={state.error}
            look={look}
            life={false}
          />
        )}
      />
    );
  }
  const work = async (
    event: Event | undefined,
    details: { source: string }
  ) => {
    const run = runWork(action, event, details, look.failedLabel);
    running.current = run;
    return await run;
  };
  return (
    <ClosePrimitive
      {...rest}
      action={work}
      render={(
        props: Record<string, unknown>,
        state: AlertDialogCloseState
      ) => (
        <PressPrimitive
          {...props}
          pendingAnnouncement=""
          onClick={(event: MouseEvent<HTMLElement>) => {
            running.current = null;
            // SAFETY: UI SDK's AlertDialogClose gives its press handler as onClick, a mouse handler.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
            const press = props.onClick as
              | ((pressed: MouseEvent<HTMLElement>) => void)
              | undefined;
            press?.(event);
            return running.current ?? undefined;
          }}
          render={(pressProps: Record<string, unknown>) => (
            <ActionButton
              props={pressProps}
              state={state.pending ? "working" : "idle"}
              error={state.error}
              look={look}
              life
            />
          )}
        />
      )}
    />
  );
};

/**
 * An answer in the footer: the safe answer, or the one action. Both close the alert dialog, the action
 * after its work when it has some.
 */
export const AlertDialogAction = (props: AlertDialogActionProps) => {
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
  // Every answer but the safe one is grave, so an agent's press waits for the person's yes, danger or not.
  const words = typeof children === "string" ? children : undefined;
  const confirm =
    agentConfirm ??
    (variant && variant !== "quiet" && variant !== "ghost" ? words : undefined);
  const look = {
    children,
    variant,
    icon,
    workingLabel,
    failedLabel,
    agentConfirm: confirm,
  };
  if (still) {
    const busy = still.busy && action !== undefined;
    return (
      <ActionButton
        props={{ type: "button" }}
        state={busy ? "working" : "idle"}
        error={undefined}
        look={look}
        still={still.look.action}
        life={action !== undefined}
      />
    );
  }
  return <LiveAction rest={rest} action={action} look={look} />;
};
