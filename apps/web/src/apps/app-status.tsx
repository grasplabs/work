import type { App } from "@grasp-os/shared/apps";
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
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { useCoreAction } from "../use-core-action.ts";

// Where an App (core's App) is in its life, and its builders moving it,
// in plain words (its badge is every subject's: drafts/status-badge.tsx);
// and Archive or Restore to put it away or take it back. A new App opens only
// for its builders, and its triggers don't fire, until it is shared. Core decides who may move
// it (app-status.ts); a refusal shows under the buttons.

/** What a builder can move an App along, as core's `apps` names it. */
type Transition = "archive" | "restore";

/**
 * Asks before archiving: it takes the App offline and stops its runs,
 * which a restore doesn't start again.
 */
export const ArchiveDialog = ({
  name,
  open,
  onOpenChange,
  onArchive,
}: {
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onArchive: () => void;
}) => (
  <AlertDialog onOpenChange={onOpenChange} open={open}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>
          <Trans>Archive {name}?</Trans>
        </AlertDialogTitle>
        <AlertDialogDescription>
          <Trans>
            An archived App is kept as it is and goes offline: nobody opens its
            pages, its triggers stop and its unfinished runs are cancelled. A
            builder can restore it later.
          </Trans>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>
          <Trans>Cancel</Trans>
        </AlertDialogCancel>
        <AlertDialogAction onClick={onArchive} variant="destructive">
          <Trans>Archive</Trans>
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

/**
 * Moves the App `app` along (`transition`), then reads the page again,
 * whatever core answered, so the controls act on the status shown: `busy`
 * meanwhile, and `failure` saying why core refused.
 */
export const useStatusMove = (app: string) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const move = (transition: Transition): void => {
    void run(async (session) => {
      await changeThenRefresh(
        async () => await session.apps[transition](app),
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return { busy, failure, move };
};

/** What the page says under the name of an App that isn't live. */
export const StatusNote = ({
  app,
}: {
  app: Pick<App, "archived" | "currentVersion">;
}) => {
  const { t } = useLingui();
  if (app.archived) {
    return (
      <p className="text-muted-foreground">
        {t`Archived: nobody opens its pages and nothing runs, until a builder restores it.`}
      </p>
    );
  }
  if (app.currentVersion === null) {
    return (
      <p className="text-muted-foreground">
        {t`Only its builders open it, and its triggers don't fire, until it is shared with the team.`}
      </p>
    );
  }
  return null;
};
