// DialogAction: an action in a dialog's footer (dialog.tsx), a Grasp Button that UI SDK's
// DialogClose drives: it closes the dialog, after its work when it has some, and shows that work
// as a Button does (working, then failed if it failed).
"use client";

import { Button as PressPrimitive } from "@ui-sdk/react/button";
import { DialogClose as ClosePrimitive } from "@ui-sdk/react/dialog";
import type { DialogCloseState } from "@ui-sdk/react/dialog";
import { useRef } from "react";
import type { ComponentProps, MouseEvent } from "react";

import type { ButtonLayoutStyle, ButtonVariant, ButtonWords } from "../button";
import { CloseActionButton, runCloseWork } from "../button/action-core";
import type { CloseActionButtonProps } from "../button/action-core";
import { buttonWords } from "../button/words";
import type { ButtonOwnWords } from "../button/words";
import type { IconData } from "../icons";
import { useWords } from "../words/words";
import { useStill } from "./still-context";
import { dialogStyles as styles } from "./styles";

type ClosePrimitiveProps = ComponentProps<typeof ClosePrimitive>;

/** What every action takes. */
interface ActionBase extends Omit<
  ClosePrimitiveProps,
  "render" | "children" | "className" | "style" | "action"
> {
  /** The words on the action: a verb first ("Rename"), or "Cancel". */
  children: ButtonWords;
  /**
   * The action is a Button: `quiet` for Cancel, `ink` for the one step the dialog is for, `danger`
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
  /**
   * This instance's own words, over the catalogue's (GraspWords), key by key (`{ actionFailed: "Could not save" }`): Button's
   * (`button`), as the action is one. Any left out are the catalogue's, else English. Its
   * `workingLabel` and `failedLabel` stay its own props and win.
   */
  words?: Partial<ButtonOwnWords>;
}

/** An action that only closes, such as Cancel. */
interface WithoutWork {
  action?: undefined;
  workingLabel?: never;
  failedLabel?: never;
}

/**
 * An action with work to do before the dialog closes.
 */
interface WithWork {
  /**
   * The work. Return a Promise and the dialog stays open while it runs: the button says it is
   * working and keeps its width. If it fails, the button says so and the dialog stays open.
   */
  action: (event: Event | undefined, details: { source: string }) => unknown;
  /** The words while the work runs ("Renaming"). Leave it out to keep the button's own words. */
  workingLabel?: string;
  /**
   * The words when the work failed, said plainly on the button and to a screen reader: what did
   * not happen ("Could not rename"). Say the action's own words; leave it out for the neutral one.
   * @default "Could not finish"
   */
  failedLabel?: string;
}

/** Every prop a DialogAction takes: these, and the rest of UI SDK's DialogClose. */
export type DialogActionProps = ActionBase & (WithoutWork | WithWork);

/** An action's Button, as a dialog's footer draws it. Alert dialog (src/components/alert-dialog) draws its actions with it too. */
export interface ActionButtonProps extends Omit<
  CloseActionButtonProps,
  "place" | "look"
> {
  look: Pick<ActionBase, "children" | "variant" | "icon" | "agentConfirm"> & {
    workingLabel?: string;
    failedLabel?: string;
    /** The action's own words (DialogAction's `words`), over the catalogue's. */
    words?: Partial<ButtonOwnWords> | undefined;
  };
  /** Its place in a still drawing for the docs (still.styles.ts), in place of its own. */
  still?: ButtonLayoutStyle;
}

/** The closing action's Button (src/components/button/action-core.tsx), in its place: the still drawing's, or its own. */
export const ActionButton = ({ still, ...rest }: ActionButtonProps) => (
  <CloseActionButton {...rest} place={still ?? styles.action} />
);

/**
 * Runs an action's work after the press, a moment later, as UI SDK settles it. A failure rejects
 * with the failure words, so an agent's press fails with them.
 */
export const runWork = runCloseWork;

interface LiveActionProps {
  rest: Omit<ActionBase, "children" | "variant" | "icon" | "agentConfirm">;
  action: WithWork["action"] | undefined;
  look: ActionButtonProps["look"];
}

// The live action. With work, the press goes through UI SDK's Button as well as its DialogClose:
// the Button's press returns the work's Promise, so an agent's press waits for the work, and a
// failure fails the step with the failure words. UI SDK settles that Promise itself, so a
// person's failed press reaches the console as nothing.
const LiveAction = ({ rest, action, look }: LiveActionProps) => {
  const running = useRef<Promise<unknown> | null>(null);
  const { actionFailed } = useWords("button", buttonWords, look.words);
  if (action === undefined) {
    return (
      <ClosePrimitive
        {...rest}
        render={(props: Record<string, unknown>, state: DialogCloseState) => (
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
    const run = runWork(
      action,
      event,
      details,
      look.failedLabel ?? actionFailed
    );
    running.current = run;
    return await run;
  };
  return (
    <ClosePrimitive
      {...rest}
      action={work}
      render={(props: Record<string, unknown>, state: DialogCloseState) => (
        <PressPrimitive
          {...props}
          pendingAnnouncement=""
          onClick={(event: MouseEvent<HTMLElement>) => {
            running.current = null;
            // SAFETY: UI SDK's DialogClose gives its press handler as onClick, a mouse handler.
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
 * An action in the footer. It closes the dialog, after its work when it has some. Every action
 * closes: a step that keeps the dialog open belongs in the body.
 */
export const DialogAction = (props: DialogActionProps) => {
  const {
    children,
    variant,
    icon,
    action,
    workingLabel,
    failedLabel,
    agentConfirm,
    words,
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
    words,
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
