import type { App, AppMember } from "@grasp-os/shared/apps";
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
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { formatList } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";

// Where an App (core's App) is in its life, and its builders moving it,
// in plain words: "Only you see this" until it is shared with the team
// (its first version live, and someone to use it), then who uses it; and
// Archive or Restore to put it away or take it back. A new App opens only
// for its builders, and its triggers don't fire, until it is shared. Core decides who may move
// it (app-status.ts); a refusal shows under the buttons.

/** Where an App is: core keeps only `archived` and its live version. */
export type AppStatus = "draft" | "live" | "archived";

/** The status of `app`, from whether it is archived and has a live version. */
export const statusOf = (
  app: Pick<App, "archived" | "currentVersion">
): AppStatus => {
  if (app.archived) {
    return "archived";
  }
  return app.currentVersion === null ? "draft" : "live";
};

/**
 * Who uses the App by name, as its state says it: the teams, people and
 * projects it is shared with, those with a name the person may read.
 */
export const userNames = (members: readonly AppMember[]): string[] =>
  members.flatMap(({ name }) => (name === null ? [] : [name]));

/** Who uses it, as a whole sentence: one name, several, or the team. */
const UsedBy = ({ who }: { who: readonly string[] | undefined }) => {
  const [only] = who ?? [];
  if (who === undefined || only === undefined) {
    return <Trans>Your team uses it</Trans>;
  }
  if (who.length === 1) {
    return <Trans>{only} uses it</Trans>;
  }
  const names = formatList(who);
  return <Trans>{names} use it</Trans>;
};

/**
 * Where an App stands, in words anyone reads: "Only you see this" until a
 * version is live and shared with someone; then who uses it, by name
 * (`who`), or "Your team" where the page doesn't read whom it is shared
 * with (a card on the Apps page).
 */
export const StatusBadge = ({
  app,
  who,
}: {
  app: Pick<App, "archived" | "currentVersion">;
  /** Whom it is shared with, by name; none where the page doesn't read it. */
  who?: readonly string[];
}) => {
  const status = statusOf(app);
  if (status === "archived") {
    return (
      <Badge variant="outline">
        <Trans context="an App put away">Archived</Trans>
      </Badge>
    );
  }
  if (status === "draft" || who?.length === 0) {
    return (
      <Badge variant="attention">
        <Trans>Only you see this</Trans>
      </Badge>
    );
  }
  return (
    <Badge variant="passed">
      <UsedBy who={who} />
    </Badge>
  );
};

/** What a builder can move an App along, as core's `apps` names it. */
export type Transition = "archive" | "restore";

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
        async () => await moveOf(session, app, transition),
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
  const status = statusOf(app);
  if (status === "draft") {
    return (
      <p className="text-muted-foreground">
        {t`Only its builders open it, and its triggers don't fire, until it is shared with the team.`}
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
