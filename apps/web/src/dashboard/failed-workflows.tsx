import type {
  Notification,
  NotificationCursor,
  NotificationPage,
} from "@grasp-os/shared/notifications";
import { Button } from "@grasp-os/ui/components/button";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { TriangleAlertIcon } from "lucide-react";

import type { Session } from "../core.ts";
import { listedOrNone } from "../directory.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { AskToFix } from "../workflows/fix-in-chat.tsx";
import { ItemMark } from "./dashboard-card.tsx";

// On the dashboard: the workflows that failed while acting for the person
// (core's notifications), each with a way to the workflow, and to a new
// chat that asks the agent to fix it, the run's failure report attached.
// The latest page shows first, and older ones on asking; each page is
// marked read as it shows, and the nav's count goes with it.

export interface NotificationsPage {
  page: NotificationPage;
  /**
   * The model a fix is asked with: the deployment's default; none while
   * chats are off, or no model is set up, and nobody is offered to ask.
   */
  model: string | undefined;
}

/**
 * A page of the person's notifications (the latest, or those older than
 * `before`), marked read as shown: only its unread ones, only as they
 * were when listed.
 */
const readPage = async (
  session: Session,
  before?: NotificationCursor
): Promise<NotificationPage> => {
  const page = await session.notifications.list(before);
  const unread = page.notifications.filter(({ read }) => !read);
  const [newest] = page.notifications;
  if (unread.length > 0 && newest !== undefined) {
    await session.notifications.markRead(
      unread.map(({ id }) => id),
      newest.at
    );
  }
  return page;
};

/** The latest page, and the model to ask a fix with. */
export const readNotifications = async (
  session: Session
): Promise<NotificationsPage> => {
  const [page, models] = await Promise.all([
    readPage(session),
    listedOrNone(session.chats.models()),
  ]);
  return { page, model: models[0] };
};

/** One notification: which workflow failed, how often, and when last. */
const FailedWorkflow = ({
  notification,
  model,
}: {
  notification: Notification;
  model: string | undefined;
}) => {
  const { app, appName, workflow, run, failures, at, read } = notification;
  const { t } = useLingui();
  const date = formatDateTime(at);
  const link = (
    <Link
      className="underline"
      params={{ app, workflow }}
      to="/workflows/$app/$workflow"
    >
      {workflow}
    </Link>
  );
  return (
    <li className="flex min-h-14 items-center gap-3 border-t px-4 py-2">
      <ItemMark icon={TriangleAlertIcon} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
          {read ? null : (
            <span
              aria-hidden="true"
              className="bg-status-attention size-1.5 flex-none rounded-full"
            />
          )}
          <span className="truncate">
            {read ? (
              <Trans>Failed while acting for you</Trans>
            ) : (
              <Trans>New: failed while acting for you</Trans>
            )}
          </span>
        </span>
        <span className="truncate">
          {failures > 1 ? (
            <Trans>
              {link} in {appName} failed{" "}
              <Plural one="once" other="# times" value={failures} />
            </Trans>
          ) : (
            <Trans>
              {link} in {appName} failed
            </Trans>
          )}
        </span>
        <span className="text-muted-foreground text-xs">{t`Last on ${date}`}</span>
      </div>
      {model === undefined ? null : <AskToFix model={model} run={run} />}
    </li>
  );
};

/** Older failures shown on asking, after the latest page; the dashboard keeps them, to count them too. */
export interface OlderFailures {
  rows: Notification[];
  /** Whether core has older ones still; undefined until one was asked for. */
  more: boolean | undefined;
}

/** The pages shown so far, and the way to the next older one. */
export const FailedWorkflows = ({
  page,
  older,
  onOlder,
}: {
  page: NotificationsPage;
  older: OlderFailures;
  onOlder: (older: OlderFailures) => void;
}) => {
  const shown = [...page.page.notifications, ...older.rows];
  const more = older.more ?? page.page.more;
  const { busy, failure, run } = useCoreAction();
  const { t } = useLingui();
  const showOlder = async (): Promise<void> => {
    const last = shown.at(-1);
    if (last === undefined) {
      return;
    }
    const next = await run(
      async (session) => await readPage(session, { at: last.at, id: last.id })
    );
    if (next !== undefined) {
      onOlder({
        rows: [...older.rows, ...next.notifications],
        more: next.more,
      });
    }
  };
  if (shown.length === 0) {
    return null;
  }
  return (
    <>
      <ul aria-label={t`Workflows that failed`} className="flex flex-col">
        {shown.map((notification) => (
          <FailedWorkflow
            key={notification.id}
            model={page.model}
            notification={notification}
          />
        ))}
      </ul>
      {more ? (
        <Button
          className="mx-4 my-2 self-start"
          disabled={busy}
          onClick={() => {
            void showOlder();
          }}
          variant="outline"
        >
          <Trans>Show older</Trans>
        </Button>
      ) : null}
      <div className="px-4">
        <ErrorText>{failure}</ErrorText>
      </div>
    </>
  );
};
