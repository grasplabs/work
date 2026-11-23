import { isAdmin } from "@grasp-os/shared/roles";
import { createFileRoute } from "@tanstack/react-router";

import { readDirectory } from "../directory.ts";
import { PageLoading } from "../frame/page-states.tsx";
import { InboxPage } from "../inbox/inbox-page.tsx";
import { inboxItems, unread } from "../inbox/items.ts";
import { readActivity, readWaiting } from "../inbox/read-waiting.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { WeeklyReport } from "../report/weekly-report.tsx";

// The inbox, as the prototype's (`routes/inbox.tsx`), at its address: what
// waits on the person, each item with its actions; for admins, the latest
// of the audit trail; and, while the company has a programme with Grasp,
// its weekly report. The sidebar's Inbox leads here, with how many wait.

/** How many of the trail's latest events the activity tab shows at most. */
const activityShown = 100;

const Inbox = () => {
  const { waiting, readAt, activity, report } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  return (
    <InboxPage
      activity={activity}
      items={inboxItems(waiting, identity, readAt)}
      notLoaded={unread(waiting)}
      report={
        report === undefined ? undefined : (
          <WeeklyReport programme={report.programme} report={report.read} />
        )
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
    // The report's bar is known before the page shows, so nothing moves
    // once it is there; read alongside what waits, which the page waits
    // for too.
    const [waiting, programme] = await Promise.all([
      readWaiting(core, identity),
      loadFromCore(
        core,
        async (session) => await session.onboarding.programme()
      ),
    ]);
    const planned = programme.state === "ready" ? programme.data : null;
    return {
      waiting,
      readAt: new Date().toISOString(),
      activity,
      // Not awaited: the report's dialog waits for it. None without a plan.
      report:
        planned === null
          ? undefined
          : {
              programme: planned,
              read: loadFromCore(
                core,
                async (session) => await session.boardReport.read()
              ),
            },
    };
  },
  component: Inbox,
});
