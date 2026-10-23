/**
 * The parts and words of the admin's Platform page, ported from the
 * prototype (grasplabs/prototype `components/admin/platform-parts.tsx`
 * and `platform-words.ts`): how a company stands, the rollout's rings as
 * steps, and the console's own things as the admin says them.
 */
import { cn } from "@grasp-os/ui/lib/utils";
import { CheckIcon, LoaderCircleIcon, PauseIcon, XIcon } from "lucide-react";

import type { TargetView } from "../rollout/queries.ts";
import type { StaffEvent } from "./platform-data.ts";
import type { PlatformNeed, RingState, Standing } from "./platform.ts";
import { formatPercent } from "./words.ts";

/** A ring, as the admin says it: the first three by what they are for. */
export const ringWords = (ring: number): string => {
  if (ring === 0) {
    return "Ring 0, first";
  }
  if (ring === 1) {
    return "Ring 1, early";
  }
  return ring === 2 ? "Ring 2, everyone" : `Ring ${ring}`;
};

/** A company in a rollout. */
export const targetWords: Record<TargetView["status"], string> = {
  pending: "Waits",
  deploying: "Deploying",
  done: "On it",
  failed: "Failed",
  rolled_back: "Rolled back",
  skipped: "Skipped",
  stopped: "Stopped",
};

export const standingWords: Record<Standing, string> = {
  attention: "Needs a look",
  setup: "Being set up",
  unread: "Not read",
  healthy: "Healthy",
  offboarded: "Offboarded",
};

const driftWords: Record<
  Extract<PlatformNeed, { kind: "drift" }>["drift"],
  string
> = {
  drifted: "Runs another version than the console made live",
  split: "Runs two versions at once",
  off_pin: "Runs another release than it is pinned to",
};

/** What a company needs, in a line. */
export const needWords = (need: PlatformNeed): string => {
  switch (need.kind) {
    case "failed": {
      return `Its last deploy failed (${need.releaseId}).`;
    }
    case "drift": {
      return `${driftWords[need.drift]}.`;
    }
    case "errors": {
      return `${formatPercent(need.rate)} of yesterday's requests ended in an error.`;
    }
    case "behind": {
      return `${need.releases} releases behind the newest.`;
    }
    default: {
      return "";
    }
  }
};

/**
 * What someone at Grasp did, in a line: who, then what, naming the company
 * by `nameOf` and the release or rollout by its id.
 */
export const eventWords = (
  event: StaffEvent,
  nameOf: (clientId: string) => string
): string => {
  const company = event.clientId === null ? "" : nameOf(event.clientId);
  const target = event.target ?? "";
  // A rollout's id says nothing to a reader; what it rolls out tells it apart.
  let rollout = "a rollout";
  if (event.rollout === "secrets") {
    rollout = "a secrets rollout";
  } else if (event.rollout !== null) {
    rollout = `the rollout of ${event.rollout}`;
  }
  const what: Record<StaffEvent["action"], string> = {
    "rollout.start": `started ${rollout}`,
    "rollout.approve": `approved the next ring of ${rollout}`,
    "rollout.pause": `paused ${rollout}`,
    "rollout.resume": `resumed ${rollout}`,
    "rollout.cancel": `cancelled ${rollout}`,
    "rollout.rollback": `rolled ${company} back`,
    "client.create": `added ${company}`,
    "client.ring": `moved ${company} to another ring`,
    "client.pin": `pinned ${company} to ${target}`,
    "client.unpin": `unpinned ${company}`,
    "client.rotate_secrets": `rotated ${company}'s secrets`,
    "client.apply_settings": `applied ${company}'s settings`,
    "client.sign_in": `changed how ${company}'s people sign in`,
  };
  return `${event.actor} ${what[event.action]}`;
};

const standingDot: Record<Standing, string> = {
  attention: "bg-status-attention",
  setup: "bg-foreground",
  unread: "bg-muted-foreground",
  healthy: "bg-status-agreed",
  offboarded: "bg-border",
};

/** How a company stands, as a dot and a word. */
export const StandingMark = ({ standing }: { standing: Standing }) => (
  <span
    className={cn(
      "flex items-center gap-2",
      standing === "attention" && "text-status-attention"
    )}
  >
    <span
      aria-hidden="true"
      className={cn("size-2 flex-none rounded-full", standingDot[standing])}
    />
    {standingWords[standing]}
  </span>
);

/** Where a ring stands, said to a screen reader beside its mark. */
const ringStateWords: Record<RingState, string> = {
  done: "done",
  running: "running",
  waiting: "waits on someone at Grasp",
  failed: "failed",
  stopped: "stopped",
  todo: "to come",
};

const markBase =
  "flex size-6 flex-none items-center justify-center rounded-full border";

const RingMark = ({ state }: { state: RingState }) => {
  if (state === "done") {
    return (
      <span
        className={cn(
          markBase,
          "bg-status-agreed text-background border-transparent"
        )}
      >
        <CheckIcon aria-hidden="true" className="size-3.5" />
      </span>
    );
  }
  if (state === "failed" || state === "stopped") {
    return (
      <span
        className={cn(
          markBase,
          "bg-status-attention text-background border-transparent"
        )}
      >
        <XIcon aria-hidden="true" className="size-3.5" />
      </span>
    );
  }
  if (state === "running") {
    return (
      <span className={cn(markBase, "border-foreground")}>
        <LoaderCircleIcon
          aria-hidden="true"
          className="size-3.5 motion-safe:animate-spin"
        />
      </span>
    );
  }
  if (state === "waiting") {
    return (
      <span
        className={cn(
          markBase,
          "border-status-attention text-status-attention"
        )}
      >
        <PauseIcon aria-hidden="true" className="size-3" />
      </span>
    );
  }
  return <span className={cn(markBase, "bg-card")} />;
};

/** One step of the rollout: a ring, what it says, and where it stands. */
export interface RingStep {
  ring: number;
  about: string;
  state: RingState;
}

/** A rollout's rings as steps, in a row when there is room. */
export const RingSteps = ({
  label,
  steps,
}: {
  label: string;
  steps: RingStep[];
}) => (
  <div className="@container">
    <ol
      aria-label={label}
      className="grid gap-3 @2xl:auto-cols-fr @2xl:grid-flow-col @2xl:gap-0"
    >
      {steps.map((step, index) => (
        <li className="flex gap-3 @2xl:flex-col @2xl:gap-2" key={step.ring}>
          <span className="flex items-center @2xl:pr-2">
            <RingMark state={step.state} />
            {index < steps.length - 1 ? (
              <span
                aria-hidden="true"
                className={cn(
                  "ml-2 hidden h-px flex-1 @2xl:block",
                  step.state === "done" ? "bg-status-agreed" : "bg-border"
                )}
              />
            ) : null}
          </span>
          <span className="flex min-w-0 flex-col gap-0.5 @2xl:pr-4">
            <span
              className={cn(
                step.state === "todo" && "text-muted-foreground",
                (step.state === "failed" || step.state === "stopped") &&
                  "text-status-attention"
              )}
            >
              {ringWords(step.ring)}
              <span className="sr-only">{`, ${ringStateWords[step.state]}`}</span>
            </span>
            <span className="text-muted-foreground text-xs">{step.about}</span>
          </span>
        </li>
      ))}
    </ol>
  </div>
);
