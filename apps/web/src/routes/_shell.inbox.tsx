import { isAdmin } from "@grasp-os/shared/roles";
import { createFileRoute } from "@tanstack/react-router";

import { readActivity, readWaiting } from "../dashboard/read-dashboard.ts";
import { readDirectory } from "../directory.ts";
import { PageLoading } from "../frame/page-states.tsx";
import { InboxPage } from "../inbox/inbox-page.tsx";
import { inboxItems, unread } from "../inbox/items.ts";
import { loadFromCore } from "../load-from-core.tsx";

// The inbox, as the prototype's (`routes/inbox.tsx`), at its address: what
// waits on the person, read as the dashboard reads it, each item with
// its actions; and, for admins, the latest of the audit trail. Like the
// prototype's, the sidebar doesn't list it: the dashboard holds what waits.

/** How many of the trail's latest events the activity tab shows at most. */
const activityShown = 100;

const Inbox = () => {
  const { waiting, readAt, activity } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  return (
    <InboxPage
      activity={activity}
      items={inboxItems(waiting, identity, readAt)}
      notLoaded={unread(waiting)}
      olderFailures={
        waiting.failed.state === "ready" && waiting.failed.data.page.more
      }
    />
  );
};

export const Route = createFileRoute("/_shell/inbox")({
  pendingComponent: PageLoading,
  loader: async ({ context: { core, identity } }) => {
    // Not awaited: the activity tab waits for it.
    const activity = isAdmin(identity.role)
      ? loadFromCore(core, async (session) => {
          const [latest, directory] = await Promise.all([
            readActivity(session, activityShown),
            readDirectory(session),
          ]);
          return { ...latest, directory };
        })
      : undefined;
    const waiting = await readWaiting(core, identity);
    return { waiting, readAt: new Date().toISOString(), activity };
  },
  component: Inbox,
});
