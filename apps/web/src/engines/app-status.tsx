import type { App, AppStatus, ViewedApp } from "@grasp-os/shared/apps";
import type { Identity } from "@grasp-os/shared/rpc";
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
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { ArchiveIcon, GlobeIcon } from "lucide-react";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { buildsApp } from "./app-role.ts";

// Where a domain (core's App) is in its life, and its builders moving it,
// as in the prototype (`components/apps/app-settings.tsx`,
// `publish-dialog.tsx`): its status as a badge, Publish on its bar, and
// Archive or Restore to put it away or take it back. A new domain is a
// draft: only its builders open it, and its triggers don't fire, until it
// is published. Core decides who may move it (app-status.ts); a refusal
// shows under the buttons.

const statusNames = {
  draft: msg({ message: "Draft", context: "a domain still being made" }),
  published: msg({
    message: "Published",
    context: "a domain open to the people it is shared with",
  }),
  archived: msg({ message: "Archived", context: "a domain put away" }),
} as const satisfies Record<AppStatus, unknown>;

/** A domain's status, as people read it. */
export const statusLabel = (status: AppStatus): string =>
  i18n._(statusNames[status]);

/** A domain's status as a badge: filled once published, as in the prototype. */
export const StatusBadge = ({ status }: { status: AppStatus }) => (
  <Badge variant={status === "published" ? "default" : "outline"}>
    {statusLabel(status)}
  </Badge>
);

/** What a builder can move a domain along, as core's `apps` names it. */
export type Transition = "publish" | "unpublish" | "archive" | "restore";

const moveOf = async (
  session: Session,
  app: string,
  transition: Transition
): Promise<App> => await session.apps[transition](app);

/**
 * Asks before archiving: it takes the domain offline and stops its runs,
 * which a restore doesn't start again.
 */
const ArchiveDialog = ({
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
            An archived domain is kept as it is and goes offline: nobody opens
            its apps, its triggers stop and its unfinished runs are cancelled. A
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
 * Moves the domain `app` along (`transition`), then reads the page again,
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

/**
 * A builder's controls for the domain's status: Publish (or Unpublish)
 * and Archive while it is a draft or published, Restore once archived.
 */
export const StatusActions = ({ app }: { app: App }) => {
  const { busy, failure, move } = useStatusMove(app.id);
  const [archiving, setArchiving] = useState(false);
  const { name, status } = app;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {status === "draft" ? (
          <Button
            disabled={busy || app.currentVersion === null}
            onClick={() => {
              move("publish");
            }}
            size="sm"
          >
            <GlobeIcon data-icon="inline-start" />
            <Trans>Publish</Trans>
          </Button>
        ) : null}
        {status === "published" ? (
          <Button
            disabled={busy}
            onClick={() => {
              move("unpublish");
            }}
            size="sm"
            variant="outline"
          >
            <Trans>Unpublish</Trans>
          </Button>
        ) : null}
        {status === "archived" ? (
          <Button
            disabled={busy}
            onClick={() => {
              move("restore");
            }}
            size="sm"
            variant="outline"
          >
            <Trans>Restore</Trans>
          </Button>
        ) : (
          <Button
            disabled={busy}
            onClick={() => {
              setArchiving(true);
            }}
            size="sm"
            variant="outline"
          >
            <ArchiveIcon data-icon="inline-start" />
            <Trans>Archive</Trans>
          </Button>
        )}
      </div>
      <ErrorText>{failure}</ErrorText>
      <ArchiveDialog
        name={name}
        onArchive={() => {
          setArchiving(false);
          move("archive");
        }}
        onOpenChange={setArchiving}
        open={archiving}
      />
    </div>
  );
};

/** What the page says under the name of a domain that isn't published. */
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
        {t`Archived: nobody opens its apps and nothing runs, until a builder restores it.`}
      </p>
    );
  }
  return null;
};

/**
 * The domain's status controls for `identity`: only for one who builds it
 * (`buildsApp`), by their role in this App; nothing for anyone else.
 */
export const AppStatusControls = ({
  app,
  identity,
}: {
  app: ViewedApp;
  identity: Pick<Identity, "staff">;
}) => (buildsApp(app, identity) ? <StatusActions app={app} /> : null);
