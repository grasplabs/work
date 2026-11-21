import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { PagePanel } from "../frame/page-panel.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import {
  PageSkeletonDetail,
  PageSkeletonListDetail,
} from "../grasp/blocks/page-skeleton-list-detail/page-skeleton-list-detail.tsx";
import { groupOrder } from "../inbox/groups.ts";
import { InboxPage } from "../inbox/inbox-page.tsx";
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

/**
 * The Inbox before what waits is read: the library's page-skeleton-list-detail,
 * the list under the page's bar with no header of its own (the page has
 * none), and the chosen item waiting in the shell's page panel, which the
 * shell shows beside a wide page and keeps as a closed sheet on a phone, as
 * it does the loaded one.
 */
const InboxPending = () => {
  const { t } = useLingui();
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Inbox` }]} />
      <PageSkeletonListDetail
        header={false}
        iconLook="inline"
        rows={8}
        separated={false}
        size="xs"
        variant="items"
      />
      <PagePanel label={t`Inbox`}>
        <PageSkeletonDetail />
      </PagePanel>
    </>
  );
};

export const Route = createFileRoute("/_shell/inbox")({
  // The open item, and the group in view as the sidebar's Inbox view sets
  // it. A value it doesn't know (an old link, an edited address) is left
  // out, as every other page's address does, rather than an error page.
  validateSearch: (
    search: Record<string, unknown>
  ): { item?: string; group?: (typeof groupOrder)[number] } => {
    const group = groupOrder.find((each) => each === search.group);
    return {
      ...(typeof search.item === "string" ? { item: search.item } : {}),
      ...(group === undefined ? {} : { group }),
    };
  },
  pendingComponent: InboxPending,
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
