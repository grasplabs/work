import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { readWaiting } from "../dashboard/read-dashboard.ts";
import { PageLoading } from "../frame/page-states.tsx";
import { InboxPage, groupOrder } from "../inbox/inbox-page.tsx";
import { inboxItems, unread } from "../inbox/items.ts";
import { ReportItem } from "../inbox/report-row.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// The Inbox at its address: what waits on the person, each item with its
// actions (inbox-page.tsx), and the weekly report as an item once it is
// ready. The sidebar's Inbox view links each of its rows here (`?item=`)
// and opens a group (`?group=`).

const Inbox = () => {
  const { waiting, readAt, programme, report } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const { item, group } = Route.useSearch();
  return (
    <InboxPage
      chosen={item}
      foot={
        programme === null || report === undefined ? undefined : (
          <ReportItem programme={programme} report={report} />
        )
      }
      group={group}
      items={inboxItems(waiting, identity, readAt)}
      notLoaded={unread(waiting)}
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
    // The report is an item only on the day it is ready; read then, not
    // awaited: the report's page waits for it.
    const report =
      programme?.nextReport.inDays === 0
        ? loadFromCore(
            core,
            async (session) => await session.dashboard.report()
          )
        : undefined;
    return {
      waiting,
      readAt: new Date().toISOString(),
      programme,
      report,
    };
  },
  component: Inbox,
});
