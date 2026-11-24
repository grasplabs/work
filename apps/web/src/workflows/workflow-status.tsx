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
import { Link as TextLink } from "@grasp-os/ui/components/link";
import { Icon, PauseIcon, PlayIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { StatusBadge } from "../drafts/status-badge.tsx";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { useGrace } from "../use-grace.ts";
import type { TriggerBlock } from "./overview.ts";
import { triggerBlockText } from "./trigger-block.ts";

// Where an independent workflow stands, on its page: "Paused" while it is
// paused; while its triggers can't start it, why (an admin is told where to
// allow it); else, for its builders, in the words an App's bar has
// (drafts/status-badge.tsx), "Only you see this" until a version is live
// and shared, then who uses it; for anyone else, whether it is live. Beside
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

const styles = stylex.create({
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space["2"],
    rowGap: space["1"],
  },
  whole: { whiteSpace: "nowrap" },
  countdown: { display: "flex", alignItems: "center", gap: space["3"] },
});

/** Where the workflow stands, as its page says it. */
export const WorkflowStatus = ({
  live,
  paused,
  blocked,
  builder,
  admin,
  who,
}: {
  /** Its live version; null before the first. */
  live: number | null;
  paused: boolean;
  /** Why its triggers start nothing, if they can't; null where they can or aren't read. */
  blocked: TriggerBlock | null;
  /** Whether the reader builds it: they are told whom it is shared with. */
  builder: boolean;
  /** Whether the reader is an admin, who allows a trigger in the Inbox. */
  admin: boolean;
  /** Whom it is shared with, by name, for its builders; none while they are read. */
  who: readonly string[] | undefined;
}) => {
  const { t, i18n } = useLingui();
  if (paused) {
    return (
      <Badge dot variant="warning">
        {t({ message: "Paused", context: "a workflow someone paused" })}
      </Badge>
    );
  }
  if (live !== null && blocked !== null) {
    return (
      <span {...stylex.props(styles.row)}>
        <Badge dot variant="warning">
          {triggerBlockText(blocked, i18n)}
        </Badge>
        {admin && blocked.why === "waiting" ? (
          <span {...stylex.props(styles.whole)}>
            <TextLink asChild variant="plain">
              <Link to="/inbox">
                {t({
                  message: "Allow it",
                  context: "go to the Inbox to allow a trigger",
                })}
              </Link>
            </TextLink>
          </span>
        ) : null}
      </span>
    );
  }
  if (builder) {
    return who === undefined ? null : <StatusBadge live={live} who={who} />;
  }
  return live === null ? (
    <Badge>
      {t({ message: "Not live yet", context: "how a workflow stands" })}
    </Badge>
  ) : (
    <Badge variant="success">
      {t({ message: "Live", context: "how a workflow stands" })}
    </Badge>
  );
};

/** "Pauses in 4 s", with Undo beside it, while a pause may be taken back. */
const PauseCountdown = ({
  left,
  onUndo,
}: {
  left: number;
  onUndo: () => void;
}) => {
  const { t } = useLingui();
  return (
    <span aria-live="polite" {...stylex.props(styles.countdown)}>
      <Badge dot variant="warning">
        {t`Pauses in ${left} s`}
      </Badge>
      <Button onClick={onUndo} size="sm" variant="outline">
        {t({ message: "Undo", context: "take a pause back before it happens" })}
      </Button>
    </span>
  );
};

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
            {t`Nothing new starts until you resume it: a start is refused while it is paused. Runs already going carry on to their end.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t`Keep it running`}</AlertDialogCancel>
          <AlertDialogAction onClick={onPause}>{t`Pause it`}</AlertDialogAction>
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
  const { t } = useLingui();
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
    <span {...stylex.props(styles.row)}>
      <ErrorText>{failure}</ErrorText>
      {paused ? (
        <Button
          disabled={busy}
          onClick={() => {
            void change("resume");
          }}
          size="sm"
          variant="ghost"
        >
          <Icon icon={PlayIcon} />
          {t`Resume`}
        </Button>
      ) : (
        <Button
          disabled={busy}
          onClick={() => {
            setAsking(true);
          }}
          size="sm"
          variant="ghost"
        >
          <Icon icon={PauseIcon} />
          {t`Pause`}
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
