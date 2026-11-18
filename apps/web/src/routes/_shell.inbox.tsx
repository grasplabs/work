import { isAdmin } from "@grasp-os/shared/roles";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { readActivity, readWaiting } from "../dashboard/read-dashboard.ts";
import { readDirectory } from "../directory.ts";
import { PageLoading } from "../frame/page-states.tsx";
import { InboxPage, groupOrder } from "../inbox/inbox-page.tsx";
import { inboxItems, unread } from "../inbox/items.ts";
import { loadFromCore } from "../load-from-core.tsx";

// The inbox, as the prototype's (`routes/inbox.tsx`), at its address: what
// waits on the person, read as the dashboard reads it, each item with
// its actions; and, for admins, the latest of the audit trail. Like the
// prototype's, the sidebar doesn't list it: the dashboard holds what waits,
// and leads here to an item (`?item=`) only the inbox settles. The
// sidebar's Inbox view links each of its rows here the same way.

/** How many of the trail's latest events the activity tab shows at most. */
const activityShown = 100;

const Inbox = () => {
  const { waiting, readAt, activity } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const { item, group } = Route.useSearch();
  return (
    <InboxPage
      activity={activity}
      chosen={item}
      group={group}
      items={inboxItems(waiting, identity, readAt)}
      notLoaded={unread(waiting)}
      olderFailures={
        waiting.notifications.state === "ready" &&
        waiting.notifications.data.page.more
      }
    />
  );
};

export const Route = createFileRoute("/_shell/inbox")({
  // `group`: the inbox's group in view, as its filter and the sidebar's Inbox view set it.
  validateSearch: z.object({
    item: z.string().optional(),
    group: z.enum(groupOrder).optional(),
  }),
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
    // Everyone's unknown outcomes too, once a visit, whatever the view: the
    // filter offers their group, and only this page lists them (core records
    // each list in the audit trail).
    const waiting = await readWaiting(core, identity, {
      everyonesOutcomes: true,
    });
    return { waiting, readAt: new Date().toISOString(), activity };
  },
  component: Inbox,
});
