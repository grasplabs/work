import type {
  WorkflowLifecycle,
  WorkflowStage,
} from "@grasp-os/shared/workflow-lifecycle";
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
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronDownIcon, PauseIcon, PlayIcon, SendIcon } from "lucide-react";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDate } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { useGrace } from "../use-grace.ts";

// Whether an independent workflow runs, and the one place to pause it
// (prototype `components/workflow-status.tsx`): beside its name, "Live
// since …" with Pause behind it, or "Paused" with Resume; before it went
// live, its stage word. Core's lifecycle (`workflowResources.lifecycle`)
// decides who may change it: whoever may not sees the word alone.
//
// Pausing stops real work, so it asks first and says what it stops: core
// refuses new starts while it is paused, and runs already going carry on.
// After the yes it waits `graceSeconds` in the same place with Undo; only
// then is core asked. Leaving the page in those seconds pauses it at once:
// the yes was given (`useGrace`, the rule an answer in Today follows too).

/** How long a pause can be taken back before core is asked, in seconds. */
const graceSeconds = 5;

/** The words for a stage before a version went live. */
const stageWords: Readonly<Record<WorkflowStage, MessageDescriptor>> = {
  mapped: msg({ message: "Mapped", context: "workflow stage" }),
  designed: msg({ message: "Designed", context: "workflow stage" }),
  testing: msg({ message: "Testing", context: "workflow stage" }),
  live: msg({ message: "Live", context: "workflow stage" }),
  scaling: msg({ message: "Scaling", context: "workflow stage" }),
};

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
  /** Its word: the stage's before it went live, "Live since", or "Paused". */
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

/** The dot beside the status word: agreed while live, attention while paused. */
const dotClass: Readonly<Record<StatusView["shows"], string | null>> = {
  stage: null,
  live: "bg-status-agreed size-1.5 rounded-full",
  paused: "bg-status-attention size-1.5 rounded-full",
};

const StatusDot = ({ shows }: { shows: StatusView["shows"] }) => {
  const className = dotClass[shows];
  return className === null ? null : (
    <span aria-hidden="true" className={className} />
  );
};

/** The status word, and the menu of what the reader may change, if anything. */
const StatusMenu = ({
  view,
  word,
  name,
  busy,
  onPause,
  onResume,
  onAskToGoLive,
}: {
  view: StatusView;
  word: string;
  name: string;
  busy: boolean;
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
        {word}
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
            variant="ghost"
          />
        }
      >
        <StatusDot shows={view.shows} />
        {word}
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
              <Trans>Ask to go live with version {askable}</Trans>
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const WorkflowStatus = ({
  workflow,
  name,
  lifecycle,
  onChange,
}: {
  workflow: string;
  name: string;
  lifecycle: WorkflowLifecycle;
  onChange: (lifecycle: WorkflowLifecycle) => void;
}) => {
  const { t, i18n } = useLingui();
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
  const words: Readonly<Record<StatusView["shows"], string>> = {
    stage: i18n._(stageWords[lifecycle.stage]),
    live: t`Live since ${since}`,
    paused: t({ message: "Paused", context: "a workflow someone paused" }),
  };
  const { waiting, liveVersion } = view;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <StatusMenu
          busy={busy}
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
        {/* Which version is live, for everyone: not only in the menu of
            those who may change it. */}
        {liveVersion === null || view.liveSince === null ? null : (
          <span className="text-muted-foreground">
            {t`Version ${liveVersion} went live on ${since}`}
          </span>
        )}
        {waiting === null ? null : (
          <span className="text-muted-foreground">
            <Trans>Version {waiting} waits to go live</Trans>
          </span>
        )}
      </div>
      <ErrorText>{failure}</ErrorText>
      <PauseQuestion
        name={name}
        onOpenChange={setAsking}
        onPause={() => {
          setAsking(false);
          hold(lifecycle.revision);
        }}
        open={asking}
      />
    </div>
  );
};
