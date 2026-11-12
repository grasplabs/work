import type { WorkflowLifecycle } from "@grasp-os/shared/workflow-lifecycle";
import { liveStages } from "@grasp-os/shared/workflow-lifecycle";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronDownIcon, PauseIcon, PlayIcon, SendIcon } from "lucide-react";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDate, formatList } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { useGrace } from "../use-grace.ts";

// Whether an independent workflow runs, and the one place to pause it
// (prototype `components/workflow-status.tsx`): at the end of its bar,
// "Runs for <who> since …" with Pause behind it, or "Paused" with
// Resume; before it went live, "Only you see this", as only its builders
// try it, with asking to go live behind it. Core's lifecycle (`workflowResources.lifecycle`)
// decides who may change it: whoever may not sees the word alone.
//
// Pausing stops real work, so it asks first and says what it stops: core
// refuses new starts while it is paused, and runs already going carry on.
// After the yes it waits `graceSeconds` in the same place with Undo; only
// then is core asked. Leaving the page in those seconds pauses it at once:
// the yes was given (`useGrace`, the rule an answer in Today follows too).
//
// The version waiting to go live is approved or sent back on the page too
// (`GoLiveDecision`), by whoever core lets decide it (`canDecide`), as in
// the inbox: then the page's one highlighted action, in place of this.

/** How long a pause can be taken back before core is asked, in seconds. */
const graceSeconds = 5;

/**
 * The published version a builder may ask to go live: the latest, when it
 * isn't live already nor waiting to.
 */
const goLiveCandidate = (lifecycle: WorkflowLifecycle): number | null => {
  const { publishedVersion, live, goLive } = lifecycle;
  if (
    publishedVersion === null ||
    publishedVersion === live?.version ||
    publishedVersion === goLive?.version
  ) {
    return null;
  }
  return publishedVersion;
};

/** What the status control says, and what it offers the reader. */
export interface StatusView {
  /** Its word: "Only you see this" before it went live, who it runs for, or "Paused". */
  shows: "stage" | "live" | "paused";
  /** When the live version was approved, if one went live. */
  liveSince: string | null;
  liveVersion: number | null;
  /** Pause, for whoever may change it while it is live and running. */
  canPause: boolean;
  /** Resume, for whoever may change it while it is paused. */
  canResume: boolean;
  /** The version they may ask to go live, for whoever may change it. */
  askable: number | null;
  /** The version waiting to go live, if one is. */
  waiting: number | null;
}

/** How `lifecycle` reads in the status control. */
export const statusOf = (lifecycle: WorkflowLifecycle): StatusView => {
  const isLive = liveStages.includes(lifecycle.stage);
  const paused = lifecycle.paused !== null;
  let shows: StatusView["shows"] = "stage";
  if (paused) {
    shows = "paused";
  } else if (isLive && lifecycle.live !== null) {
    shows = "live";
  }
  const { canChange } = lifecycle;
  return {
    shows,
    liveSince: lifecycle.live?.approvedAt ?? null,
    liveVersion: lifecycle.live?.version ?? null,
    canPause: canChange && isLive && !paused,
    canResume: canChange && paused,
    askable: canChange ? goLiveCandidate(lifecycle) : null,
    waiting: lifecycle.goLive?.version ?? null,
  };
};

/** "Pauses in 4 s", with Undo beside it, while a pause may be taken back. */
const PauseCountdown = ({
  left,
  onUndo,
}: {
  left: number;
  onUndo: () => void;
}) => (
  <span aria-live="polite" className="flex items-center gap-3 font-medium">
    <span className="text-muted-foreground flex items-center gap-2 tabular-nums">
      <span
        aria-hidden="true"
        className="bg-status-attention size-1.5 rounded-full motion-safe:animate-pulse"
      />
      <Trans>Pauses in {left} s</Trans>
    </span>
    <Button onClick={onUndo} size="sm" variant="outline">
      <Trans context="take a pause back before it happens">Undo</Trans>
    </Button>
  </span>
);

/** Asks before pausing, and says what a pause stops and what it doesn't. */
const PauseQuestion = ({
  name,
  open,
  onOpenChange,
  onPause,
}: {
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPause: () => void;
}) => {
  const { t } = useLingui();
  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t`Pause ${name}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>
              Nothing new starts until you resume it: a start is refused while
              it is paused. Runs already going carry on to their end.
            </Trans>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            <Trans>Keep it running</Trans>
          </AlertDialogCancel>
          <AlertDialogAction onClick={onPause}>
            <Trans>Pause it</Trans>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/**
 * The dot beside the status word: attention before it went live, as only
 * its builders try it, and while paused; agreed while it runs.
 */
const dotClass: Readonly<Record<StatusView["shows"], string>> = {
  stage: "bg-status-attention size-1.5 rounded-full",
  live: "bg-status-agreed size-1.5 rounded-full",
  paused: "bg-status-attention size-1.5 rounded-full",
};

const StatusDot = ({ shows }: { shows: StatusView["shows"] }) => (
  <span aria-hidden="true" className={dotClass[shows]} />
);

/** The status word, and the menu of what the reader may change, if anything. */
const StatusMenu = ({
  view,
  word,
  name,
  busy,
  highlight,
  onPause,
  onResume,
  onAskToGoLive,
}: {
  view: StatusView;
  word: string;
  name: string;
  busy: boolean;
  /** Whether it is the page's one lime action. */
  highlight: boolean;
  onPause: () => void;
  onResume: () => void;
  onAskToGoLive: (version: number) => void;
}) => {
  const { t } = useLingui();
  const { askable, canPause, canResume } = view;
  if (!canPause && !canResume && askable === null) {
    return (
      <span className="flex items-center gap-2 font-medium">
        <StatusDot shows={view.shows} />
        <span className="max-w-48 truncate">{word}</span>
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={t`${word}. Change whether ${name} runs`}
            disabled={busy}
            size="sm"
            variant={highlight ? "highlight" : "outline"}
          />
        }
      >
        <StatusDot shows={view.shows} />
        {/* Capped, so who it runs for never takes the name's room. */}
        <span className="max-w-48 truncate">{word}</span>
        <ChevronDownIcon data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuGroup>
          {canPause ? (
            <DropdownMenuItem onClick={onPause}>
              <PauseIcon />
              <Trans>Pause</Trans>
            </DropdownMenuItem>
          ) : null}
          {canResume ? (
            <DropdownMenuItem onClick={onResume}>
              <PlayIcon />
              <Trans>Resume</Trans>
            </DropdownMenuItem>
          ) : null}
          {askable === null ? null : (
            <DropdownMenuItem
              onClick={() => {
                onAskToGoLive(askable);
              }}
            >
              <SendIcon />
              <Trans>Ask to run version {askable} for the team</Trans>
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/**
 * The status control, in the workflow's bar: its word, and the menu of
 * what the reader may change, the page's one lime action unless another
 * is (`highlight`).
 */
export const WorkflowStatus = ({
  workflow,
  name,
  lifecycle,
  highlight = true,
  who,
  onChange,
}: {
  workflow: string;
  name: string;
  lifecycle: WorkflowLifecycle;
  highlight?: boolean;
  /** Whom it is shared with, by name; none where the page doesn't read it. */
  who?: readonly string[] | undefined;
  onChange: (lifecycle: WorkflowLifecycle) => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const { busy, failure, run } = useCoreAction();
  const [asking, setAsking] = useState(false);

  const change = async (
    write: "pause" | "resume" | "requestGoLive",
    input: { revision: number; version?: number }
  ): Promise<void> => {
    let conflict = false;
    const changed = await run(async (session) => {
      try {
        return await session.workflowResources.lifecycle[write](
          workflow,
          input
        );
      } catch (error) {
        conflict =
          workflowResourceErrors.codeOf(error) ===
          "workflow.lifecycle_conflict";
        throw error;
      }
    });
    if (changed !== undefined) {
      onChange(changed);
      return;
    }
    if (conflict) {
      // Changed by someone else first: how it stands now is read, so the
      // next change names the revision core has, and why this one failed
      // still shows.
      try {
        onChange(
          await core.withSession(
            async (session) =>
              await session.workflowResources.lifecycle.get(workflow)
          )
        );
      } catch {
        // The page's own read says how it stands when it is loaded again.
      }
    }
  };

  // The pause is real: core is asked, with the revision the yes was given
  // at; once the page is gone, with nobody left on it to tell. The
  // workflow's page says how it stands when it is opened again.
  const { held, hold, undo } = useGrace<number>({
    seconds: graceSeconds,
    go: (revision) => {
      void change("pause", { revision });
    },
    goOnLeave: (revision) => {
      void (async () => {
        try {
          await core.withSession(
            async (session) =>
              await session.workflowResources.lifecycle.pause(workflow, {
                revision,
              })
          );
        } catch {
          // Nobody is left on the page to tell.
        }
      })();
    },
  });

  if (held !== null) {
    return <PauseCountdown left={held.left} onUndo={undo} />;
  }

  const view = statusOf(lifecycle);
  const since = view.liveSince === null ? "" : formatDate(view.liveSince);
  const users = formatList(who ?? []);
  const runsFor =
    who === undefined || who.length === 0
      ? t`Runs for your team since ${since}`
      : t`Runs for ${users} since ${since}`;
  const words: Readonly<Record<StatusView["shows"], string>> = {
    stage: t`Only you see this`,
    live: runsFor,
    paused: t({ message: "Paused", context: "a workflow someone paused" }),
  };
  return (
    <span className="flex items-center gap-2">
      <ErrorText>{failure}</ErrorText>
      <StatusMenu
        busy={busy}
        highlight={highlight}
        name={name}
        onAskToGoLive={(version) => {
          void change("requestGoLive", {
            version,
            revision: lifecycle.revision,
          });
        }}
        onPause={() => {
          setAsking(true);
        }}
        onResume={() => {
          void change("resume", { revision: lifecycle.revision });
        }}
        view={view}
        word={words[view.shows]}
      />
      <PauseQuestion
        name={name}
        onOpenChange={setAsking}
        onPause={() => {
          setAsking(false);
          hold(lifecycle.revision);
        }}
        open={asking}
      />
    </span>
  );
};

/**
 * Which version is live, since when, and which waits to go live, for
 * everyone: not only in the status menu of those who may change it.
 */
export const LiveFacts = ({ lifecycle }: { lifecycle: WorkflowLifecycle }) => {
  const { t } = useLingui();
  const { waiting, liveVersion, liveSince } = statusOf(lifecycle);
  const since = liveSince === null ? "" : formatDate(liveSince);
  if (liveVersion === null && waiting === null) {
    return <Trans>It doesn’t run for anyone yet.</Trans>;
  }
  return (
    <span className="flex flex-col gap-1">
      {liveVersion === null || liveSince === null ? null : (
        <span>{t`Version ${liveVersion} has run for the team since ${since}`}</span>
      )}
      {waiting === null ? null : (
        <span className="text-muted-foreground">
          <Trans>
            Version {waiting} waits for approval to run for the team
          </Trans>
        </span>
      )}
    </span>
  );
};

/** The decision on the version waiting to go live, as the reader has it. */
export interface GoLiveChoice {
  version: number;
  /** Whether another version is live: approving it changes that one. */
  change: boolean;
  /** Whether the reader asked for it and decides it as nobody else may. */
  selfApproval: boolean;
}

/**
 * What `me` may decide of the version waiting in `lifecycle`: nothing
 * unless one waits and core lets them decide it (`canDecide`).
 */
export const goLiveChoiceOf = (
  lifecycle: WorkflowLifecycle,
  me: string
): GoLiveChoice | null => {
  const { goLive } = lifecycle;
  if (!lifecycle.canDecide || goLive === null) {
    return null;
  }
  return {
    version: goLive.version,
    change: lifecycle.live !== null,
    selfApproval: goLive.onlyApprover && goLive.requestedBy === me,
  };
};

/**
 * The version waiting to go live, approved or sent back by whoever core
 * lets decide it (`canDecide`): the workflow's owner, an admin, or whoever
 * asked for it while nobody else may, recorded as self-approved. The same
 * decision as the inbox's (`lifecycle.decideGoLive`), at the revision this
 * page read, so a change made meanwhile is refused rather than overruled.
 * Approving a version while another is live approves a change to it.
 */
export const GoLiveDecision = ({
  workflow,
  name,
  me,
  lifecycle,
  onChange,
}: {
  workflow: string;
  name: string;
  me: string;
  lifecycle: WorkflowLifecycle;
  onChange: (lifecycle: WorkflowLifecycle) => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const choice = goLiveChoiceOf(lifecycle, me);
  if (choice === null) {
    return null;
  }
  const { version } = choice;
  const who = name;
  const decide = async (verdict: "approve" | "reject"): Promise<void> => {
    const changed = await run(
      async (session) =>
        await session.workflowResources.lifecycle.decideGoLive(workflow, {
          version,
          verdict,
          revision: lifecycle.revision,
        })
    );
    if (changed !== undefined) {
      onChange(changed);
    }
  };
  return (
    <div className="flex max-w-sm flex-col items-start gap-2">
      <fieldset
        aria-label={t`Let version ${version} of ${who} run for the team`}
        className="flex flex-wrap gap-2"
      >
        <Button
          disabled={busy}
          onClick={() => {
            void decide("approve");
          }}
          variant="highlight"
        >
          {choice.change ? (
            <Trans>Approve the change</Trans>
          ) : (
            <Trans>Approve, and it runs for the team</Trans>
          )}
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            void decide("reject");
          }}
          variant="outline"
        >
          <Trans>Send back</Trans>
        </Button>
      </fieldset>
      {choice.selfApproval ? (
        <p className="text-muted-foreground">
          {t`You asked for this yourself, and nobody else may approve it, so you decide it. It is recorded as self-approved.`}
        </p>
      ) : null}
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};
