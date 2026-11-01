/**
 * Steering a client's onboarding from its pages in the admin: each button
 * gives one command (src/clients/commands.ts), which the company's core
 * applies once and audits under the staff member's name, then reads the
 * organization again, so the page shows where it stands either way.
 */
import type { AdminCommand } from "@grasp-os/shared/admin-command";
import { gateThresholds } from "@grasp-os/shared/onboarding-gate";
import type { GateThreshold } from "@grasp-os/shared/onboarding-gate";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { useRouter } from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";
import { useId } from "react";

import { commandFn } from "../clients/command-functions.ts";
import type { CommandRefusal } from "../clients/commands.ts";
import { thenRefresh, useAction } from "../use-action.ts";

/** What staff read when a command didn't apply, by why. */
const refusals: Readonly<Record<CommandRefusal, string>> = {
  not_deployed:
    "The company has no Grasp to steer yet: it isn’t deployed, or the admin can’t reach it.",
  shut_out:
    "The company doesn’t let Grasp’s staff in now: open a staff window from Setup first, or ask its admin.",
  refused: "The company’s Grasp turned the request away.",
  pending: "That is being done right now. Try again in a moment.",
  "onboarding.no_link": "They have no link out yet.",
  "onboarding.no_team": "That team isn’t on the company’s list any more.",
  "onboarding.no_work": "That workflow isn’t on its team’s map any more.",
  "onboarding.no_failed_mail": "No mail to them failed.",
  "onboarding.nothing_to_draw":
    "Nobody who does that work has agreed to anything yet.",
  "onboarding.invalid": "That isn’t something the onboarding takes.",
  "onboarding.agreements_kept":
    "The team is told: what was agreed stays as it was agreed.",
  not_answered: "The company’s Grasp didn’t answer. Try again in a moment.",
};

/**
 * Gives commands to client `clientId`'s onboarding: `give` delivers one
 * and reads the organization again, `busy` holds while it does, and
 * `failure` says why the last one didn't apply.
 */
export const useCommand = (clientId: string) => {
  const router = useRouter();
  const action = useAction(refusals);
  /** Gives `command`: whether it applied. */
  const give = async (command: AdminCommand): Promise<boolean> => {
    let applied = false;
    await action.run(async () => {
      const answer = await thenRefresh(
        async () => await commandFn({ data: { clientId, command } }),
        async () => {
          await router.invalidate();
        }
      );
      applied = answer.refused === null;
      return answer;
    });
    return applied;
  };
  return { busy: action.busy, failure: action.failure, give };
};

/** Why the last command didn't apply, where it was given. */
export const CommandFailure = ({ failure }: { failure: string | null }) =>
  failure === null ? null : (
    <p className="text-destructive" role="alert">
      {failure}
    </p>
  );

/** What a command needs said before it is given: it can't be undone, or touches everyone. */
export interface Confirm {
  title: string;
  description: string;
  action: string;
}

/**
 * One button that gives `command`, asking first when `confirm` says what
 * it does, with why it didn't apply under it.
 */
export const CommandButton = ({
  clientId,
  command,
  children,
  confirm,
  disabled = false,
  label,
  variant = "outline",
}: {
  clientId: string;
  command: AdminCommand;
  children: ReactNode;
  confirm?: Confirm;
  disabled?: boolean;
  /** Its name for a screen reader, when its words don't say whom it is for. */
  label?: string;
  variant?: ComponentProps<typeof Button>["variant"];
}) => {
  const { busy, failure, give } = useCommand(clientId);
  const button =
    confirm === undefined ? (
      <Button
        aria-label={label}
        disabled={disabled || busy}
        onClick={() => {
          void give(command);
        }}
        size="sm"
        variant={variant}
      >
        {children}
      </Button>
    ) : (
      <AlertDialog>
        <AlertDialogTrigger
          disabled={disabled || busy}
          render={<Button aria-label={label} size="sm" variant={variant} />}
        >
          {children}
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void give(command);
              }}
              variant="destructive"
            >
              {confirm.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  return (
    <span className="flex flex-col items-end gap-1">
      {button}
      <CommandFailure failure={failure} />
    </span>
  );
};

const isThreshold = (value: number): value is GateThreshold =>
  gateThresholds.some((each) => each === value);

/** The gate as the snapshot has it. */
export interface GateState {
  open: boolean;
  threshold: number;
  known: number;
  ready: boolean;
  over: boolean;
  openedAt: string | null;
}

/** The go, or taking it back: what the gate allows now. */
const goCommand = (
  gate: GateState
): { command: AdminCommand; words: string; confirm?: Confirm } | null => {
  if (gate.open) {
    return {
      command: { type: "onboarding.gate.close", payload: {} },
      words:
        gate.openedAt === null
          ? "Close it for the onboarding"
          : "Take the go back",
      confirm: {
        title: "Close the company’s Grasp?",
        description:
          "Everyone but its admins and Grasp’s staff is signed out, and nobody else comes in until Grasp gives its go again.",
        action: "Close it",
      },
    };
  }
  const given = gate.openedAt !== null;
  if (!(gate.ready || given)) {
    return null;
  }
  const enough = gate.known >= gate.threshold;
  let words = "Give the go";
  if (!enough && given) {
    words = "Give the go again";
  } else if (!enough && gate.over) {
    words = "Open it anyway";
  }
  return { command: { type: "onboarding.gate.open", payload: {} }, words };
};

/** Pausing the interviews, or letting them run again. */
export const PauseButton = ({
  clientId,
  paused,
}: {
  clientId: string;
  paused: boolean;
}) =>
  paused ? (
    <CommandButton
      clientId={clientId}
      command={{ type: "onboarding.resume", payload: {} }}
    >
      Let the interviews run again
    </CommandButton>
  ) : (
    <CommandButton
      clientId={clientId}
      command={{ type: "onboarding.pause", payload: {} }}
      variant="ghost"
    >
      Pause the interviews
    </CommandButton>
  );
/**
 * Grasp's switches for the company's Grasp, beside where its go stands:
 * the share at which it opens, the go itself, and pausing the interviews.
 */
export const GateControls = ({
  clientId,
  gate,
  paused,
}: {
  clientId: string;
  gate: GateState;
  paused: boolean;
}) => {
  const thresholdId = useId();
  const threshold = useCommand(clientId);
  const go = goCommand(gate);
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <label className="sr-only" htmlFor={thresholdId}>
          How much has to be known before it opens
        </label>
        <NativeSelect
          disabled={threshold.busy || gate.open}
          id={thresholdId}
          onChange={(event) => {
            const chosen = Number(event.target.value);
            if (isThreshold(chosen)) {
              void threshold.give({
                type: "onboarding.gate.threshold",
                payload: { threshold: chosen },
              });
            }
          }}
          size="sm"
          value={String(gate.threshold)}
        >
          {gateThresholds.map((each) => (
            <NativeSelectOption key={each} value={String(each)}>
              {`Opens at ${each}%`}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <PauseButton clientId={clientId} paused={paused} />
        {go === null ? (
          <Button disabled size="sm">
            Give the go
          </Button>
        ) : (
          <CommandButton
            clientId={clientId}
            command={go.command}
            confirm={go.confirm}
            variant={gate.open ? "outline" : "default"}
          >
            {go.words}
          </CommandButton>
        )}
      </div>
      <CommandFailure failure={threshold.failure} />
    </div>
  );
};
