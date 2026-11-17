// DrawerAction: an action in a drawer's or a sheet's footer (drawer.tsx), a Grasp Button that UI
// SDK's DrawerClose drives: it closes the panel, after its work when it has some, and shows that
// work as a Button does (working, then failed if it failed). The pattern is Dialog's
// (src/components/dialog/action.tsx): a failed action rejects with its failure words, so an agent
// hears it failed, and a person's failed press logs nothing.
"use client";

import { Button as PressPrimitive } from "@ui-sdk/react/button";
import { DrawerClose as ClosePrimitive } from "@ui-sdk/react/drawer";
import { useEffect, useRef, useState } from "react";
import type { ComponentProps, MouseEvent } from "react";

import { Button } from "../button";
import type { ActionState, ButtonVariant, ButtonWords } from "../button";
import type { IconData } from "../icons";
import { ms } from "../tokens/tokens.values";
import { useStill } from "./still-context";
import { drawerStyles as styles } from "./styles";

type ClosePrimitiveProps = ComponentProps<typeof ClosePrimitive>;
interface CloseState {
  pending: boolean;
  error: unknown;
}

/** What every action takes. */
interface ActionBase extends Omit<
  ClosePrimitiveProps,
  "render" | "children" | "className" | "style" | "action"
> {
  /** The words on the action: a verb first ("Rename"), or "Cancel". */
  children: ButtonWords;
  /**
   * The action is a Button: `quiet` for Cancel, `ink` for the one step the panel is for, `danger`
   * when it deletes, `approve` when it approves.
   * @default "quiet"
   */
  variant?: ButtonVariant;
  /** An icon before the words. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /**
   * What the action does, for the person an agent must ask first ("Deletes the project"). A
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
 * An action with work to do before the panel closes.
 */
interface WithWork {
  /**
   * The work. Return a Promise and the panel stays open while it runs: the button says it is
   * working and keeps its width. If it fails, the button says so and the panel stays open.
   */
  action: (event: Event | undefined, details: { source: string }) => unknown;
  /** The words while the work runs ("Renaming"). Leave it out to keep the button's own words. */
  workingLabel?: string;
  /** The words when the work failed, said plainly on the button and to a screen reader ("Could not rename"). */
  failedLabel: string;
}

/** Every prop a DrawerAction takes: these, and the rest of UI SDK's DrawerClose. */
export type DrawerActionProps = ActionBase & (WithoutWork | WithWork);

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

interface ActionButtonProps {
  props: Record<string, unknown>;
  state: ActionState;
  error: unknown;
  look: Pick<ActionBase, "children" | "variant" | "icon" | "agentConfirm"> & {
    workingLabel?: string;
    failedLabel?: string;
  };
  /** It has work to do, so it shows the work's life: Cancel has none, and keeps its own width. */
  life: boolean;
}

/** Its place in the footer. Layout only, as a Button's style is. */
const placed = () => ({ style: styles.action });

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
      {...placed()}
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
const runWork = async (
  action: WithWork["action"],
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

interface LiveActionProps {
  rest: Omit<ActionBase, "children" | "variant" | "icon" | "agentConfirm">;
  action: WithWork["action"] | undefined;
  look: ActionButtonProps["look"];
}

// The live action. With work, the press goes through UI SDK's Button as well as its DrawerClose:
// the Button's press returns the work's Promise, so an agent's press waits for the work, and a
// failure fails the step with the failure words. UI SDK settles that Promise itself, so a
// person's failed press reaches the console as nothing.
const LiveAction = ({ rest, action, look }: LiveActionProps) => {
  const running = useRef<Promise<unknown> | null>(null);
  if (action === undefined) {
    return (
      <ClosePrimitive
        {...rest}
        render={(props: Record<string, unknown>, state: CloseState) => (
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
      render={(props: Record<string, unknown>, state: CloseState) => (
        <PressPrimitive
          {...props}
          pendingAnnouncement=""
          onClick={(event: MouseEvent<HTMLElement>) => {
            running.current = null;
            // SAFETY: UI SDK's DrawerClose gives its press handler as onClick, a mouse handler.
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
 * An action in the footer. It closes the panel, after its work when it has some. Every action
 * closes: a step that keeps the panel open belongs in the body.
 */
export const DrawerAction = (props: DrawerActionProps) => {
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
  const look = {
    children,
    variant,
    icon,
    workingLabel,
    failedLabel,
    agentConfirm,
  };
  const still = useStill();
  if (still) {
    // Drawn standing still for the docs (still.tsx): working, when the still is busy.
    const busy = still.busy && action !== undefined;
    return (
      <ActionButton
        props={{ type: "button" }}
        state={busy ? "working" : "idle"}
        error={undefined}
        look={look}
        life={action !== undefined}
      />
    );
  }
  return <LiveAction rest={rest} action={action} look={look} />;
};
