import type { App, AppStatus } from "@grasp-os/shared/apps";
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
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { useCoreAction } from "../use-core-action.ts";

// Where an App (core's App) is in its life, and its builders moving it,
// as in the prototype (`components/apps/app-settings.tsx`,
// `publish-dialog.tsx`): its status as a badge, Publish on its bar, and
// Archive or Restore to put it away or take it back. A new App is a
// draft: only its builders open it, and its triggers don't fire, until it
// is published. Core decides who may move it (app-status.ts); a refusal
// shows under the buttons.

const statusNames = {
  draft: msg({ message: "Draft", context: "an App still being made" }),
  published: msg({
    message: "Published",
    context: "an App open to the people it is shared with",
  }),
  archived: msg({ message: "Archived", context: "an App put away" }),
} as const satisfies Record<AppStatus, unknown>;

/** An App's status, as people read it. */
export const statusLabel = (status: AppStatus): string =>
  i18n._(statusNames[status]);

/** An App's status as a badge: filled once published, as in the prototype. */
export const StatusBadge = ({ status }: { status: AppStatus }) => (
  <Badge variant={status === "published" ? "default" : "outline"}>
    {statusLabel(status)}
  </Badge>
);

/** What a builder can move an App along, as core's `apps` names it. */
export type Transition = "publish" | "unpublish" | "archive" | "restore";

const moveOf = async (
  session: Session,
  app: string,
  transition: Transition
): Promise<App> => await session.apps[transition](app);

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
            builder can restore it later, as a draft.
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
        async () => await moveOf(session, app, transition),
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return { busy, failure, move };
};

/** What the page says under the name of an App that isn't published. */
export const StatusNote = ({ status }: { status: AppStatus }) => {
  const { t } = useLingui();
  if (status === "draft") {
    return (
      <p className="text-muted-foreground">
        {t`A draft: only its builders open it, and its triggers don't fire, until it is published.`}
      </p>
    );
  }
  if (status === "archived") {
    return (
      <p className="text-muted-foreground">
        {t`Archived: nobody opens its pages and nothing runs, until a builder restores it.`}
      </p>
    );
  }
  return null;
};
