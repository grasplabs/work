import type { WorkflowResource } from "@grasp-os/shared/workflow-resources";
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
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { PauseIcon, PlayIcon } from "lucide-react";
import { useState } from "react";

import { StatusBadge } from "../drafts/status-badge.tsx";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { useGrace } from "../use-grace.ts";

// Where an independent workflow stands, in its bar, in the words an App's
// bar has (drafts/status-badge.tsx): "Only you see this" until a version is
// live and shared, then who uses it; "Paused" while it is paused. Beside
// Run, for its builders, Pause while a version is live, or Resume while
// paused (`workflowResources.pause`, `resume`).
//
// Pausing stops real work, so it asks first and says what it stops: core
// refuses new starts while it is paused, and runs already going carry on.
// After the yes it waits `graceSeconds` in the same place with Undo; only
// then is core asked. Leaving the page in those seconds pauses it at once:
// the yes was given (`useGrace`, the rule an answer in Today follows too).

/** How long a pause can be taken back before core is asked, in seconds. */
const graceSeconds = 5;

/** Where the workflow stands, as its bar says it. */
export const WorkflowStatus = ({
  live,
  paused,
  who,
}: {
  /** Its live version; null before the first. */
  live: number | null;
  paused: boolean;
  /** Whom it is shared with, by name; none while they are read. */
  who: readonly string[] | undefined;
}) =>
  paused ? (
    <Badge variant="attention">
      <Trans context="a workflow someone paused">Paused</Trans>
    </Badge>
  ) : (
    <StatusBadge live={live} who={who} />
  );

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
 * Pause, or Resume while paused, beside Run, for its builders: nothing
 * before a version is live, as nothing runs to pause.
 */
export const PauseControl = ({
  workflow,
  name,
  live,
  paused,
  onChange,
}: {
  workflow: string;
  name: string;
  /** Its live version; null before the first. */
  live: number | null;
  paused: boolean;
  onChange: (changed: WorkflowResource) => void;
}) => {
  const core = useCore();
  const { busy, failure, run } = useCoreAction();
  const [asking, setAsking] = useState(false);

  const change = async (write: "pause" | "resume"): Promise<void> => {
    const changed = await run(
      async (session) => await session.workflowResources[write](workflow)
    );
    if (changed !== undefined) {
      onChange(changed);
    }
  };

  // The pause is real: core is asked once the yes stands; once the page
  // is gone, with nobody left on it to tell. The workflow's page says how
  // it stands when it is opened again.
  const { held, hold, undo } = useGrace<true>({
    seconds: graceSeconds,
    go: () => {
      void change("pause");
    },
    goOnLeave: () => {
      void (async () => {
        try {
          await core.withSession(
            async (session) => await session.workflowResources.pause(workflow)
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
  if (live === null && !paused) {
    return null;
  }
  return (
    <span className="flex items-center gap-2">
      <ErrorText>{failure}</ErrorText>
      {paused ? (
        <Button
          disabled={busy}
          onClick={() => {
            void change("resume");
          }}
          size="sm"
          variant="outline"
        >
          <PlayIcon data-icon="inline-start" />
          <Trans>Resume</Trans>
        </Button>
      ) : (
        <Button
          disabled={busy}
          onClick={() => {
            setAsking(true);
          }}
          size="sm"
          variant="outline"
        >
          <PauseIcon data-icon="inline-start" />
          <Trans>Pause</Trans>
        </Button>
      )}
      <PauseQuestion
        name={name}
        onOpenChange={setAsking}
        onPause={() => {
          setAsking(false);
          hold(true);
        }}
        open={asking}
      />
    </span>
  );
};
