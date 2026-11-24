import { createFileRoute } from "@tanstack/react-router";

import { InboxPage } from "../inbox/inbox-page.tsx";
import { InboxPending } from "../inbox/inbox-pending.tsx";
import { inboxItems, unread } from "../inbox/items.ts";
import { readWaiting } from "../inbox/read-waiting.ts";
import { ReportItem } from "../inbox/report-row.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// The Inbox at its address: what waits on the person, each item with its
// actions (inbox-page.tsx), and, while the company has a programme with
// Grasp, the weekly report: a row at the head once it is ready, a quiet
// row at the foot on every other day. The sidebar's Inbox leads here, with
// how many wait; the open item (`?item=`) is the address.

const Inbox = () => {
  const { waiting, readAt, programme, report } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const { item } = Route.useSearch();
  const reportItem =
    programme === null || report === undefined ? undefined : (
      <ReportItem programme={programme} report={report} />
    );
  // Ready: the row at the head of the list; on other days, quiet at its foot.
  const ready = programme?.nextReport.inDays === 0;
  return (
    // The page draws its own bar, so the panel beside the list stands
    // beside the bar too.
    <InboxPage
      chosen={item}
      foot={ready ? reportItem : undefined}
      items={inboxItems(waiting, identity, readAt)}
      notLoaded={unread(waiting)}
      tail={ready ? undefined : reportItem}
    />
  );
};

export const Route = createFileRoute("/_shell/inbox")({
  // The open item. A value it doesn't know (an edited address) is left
  // out, as every other page's address does, rather than an error page.
  validateSearch: (search: Record<string, unknown>): { item?: string } =>
    typeof search.item === "string" ? { item: search.item } : {},
  pendingComponent: InboxPending,
  loader: async ({ context: { core, identity } }) => {
    const [waiting, read] = await Promise.all([
      readWaiting(core, identity),
      // The programme with Grasp, for the weekly report; none without a plan.
      loadFromCore(
        core,
        async (session) => await session.onboarding.programme()
      ),
    ]);
    const programme = read.state === "ready" ? read.data : null;
    // The report on the week, ready or so far, not awaited: its sheet
    // waits for it.
    const report =
      programme === null
        ? undefined
        : loadFromCore(
            core,
            async (session) => await session.boardReport.read()
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
