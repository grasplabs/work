import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { PageLoading } from "../frame/page-states.tsx";
import { InboxPage, groupOrder } from "../inbox/inbox-page.tsx";
import { inboxItems, unread } from "../inbox/items.ts";
import { readWaiting } from "../inbox/read-waiting.ts";
import { ReportItem } from "../inbox/report-row.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// The Inbox at its address: what waits on the person, each item with its
// actions (inbox-page.tsx), and the weekly report: an item at the head once
// it is ready, a quiet row at the foot on every other day. The sidebar's Inbox view links each of its rows here (`?item=`)
// and opens a group (`?group=`).

const Inbox = () => {
  const { waiting, readAt, programme, report } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const { item, group } = Route.useSearch();
  const reportItem =
    programme === null || report === undefined ? undefined : (
      <ReportItem programme={programme} report={report} />
    );
  // Ready: the item at the head of the list; on other days, quiet at its foot.
  const ready = programme?.nextReport.inDays === 0;
  return (
    <InboxPage
      chosen={item}
      foot={ready ? reportItem : undefined}
      group={group}
      items={inboxItems(waiting, identity, readAt)}
      notLoaded={unread(waiting)}
      tail={ready ? undefined : reportItem}
    />
  );
};

export const Route = createFileRoute("/_shell/inbox")({
  validateSearch: z.object({
    item: z.string().optional(),
    // The group in view, as the sidebar's Inbox view sets it.
    group: z.enum(groupOrder).optional(),
  }),
  pendingComponent: PageLoading,
  loader: async ({ context: { core, identity } }) => {
    // Everyone's unknown outcomes too, once a visit: only this page lists
    // them (core records each list in the audit trail).
    const [waiting, read] = await Promise.all([
      readWaiting(core, identity, { everyonesOutcomes: true }),
      // The programme with Grasp, for the weekly report; none without a plan.
      loadFromCore(
        core,
        async (session) => await session.onboarding.programme()
      ),
    ]);
    const programme = read.state === "ready" ? read.data : null;
    // The report on the week, ready or so far, read every day and not
    // awaited: the report's page waits for it.
    const report =
      programme === null
        ? undefined
        : loadFromCore(
            core,
            async (session) => await session.dashboard.report()
          );
    return {
      waiting,
      readAt: new Date().toISOString(),
      programme,
      report,
    };
  },
  component: Inbox,
});
