import { buttonVariants } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";

import { ItemMark, kindLabel } from "../inbox/inbox-kind.tsx";
import { inboxItems } from "../inbox/items.ts";
import type { InboxItem, InboxSource } from "../inbox/items.ts";
import { DashboardGroup } from "./dashboard-card.tsx";
import type { Viewer, Waiting } from "./waiting.ts";

// What waits on the person that only the inbox settles: versions of Apps
// and workflows asked to go live, decisions runs wait on, questions of the
// brain asked of them, and schedules that stopped. The nav's count holds
// them, so the dashboard lists them too, each a way to its item in the
// inbox, where it is decided.

/** What the inbox settles and the dashboard has no card of its own for. */
const settledInInbox = new Set<InboxSource["type"]>([
  "version",
  "workflowGoLive",
  "decision",
  "asked",
  "stopped",
]);

/** The items of what was read that wait in the inbox, in its order. */
export const inInbox = (
  waiting: Waiting,
  viewer: Viewer & { name: string },
  readAt: string
): InboxItem[] =>
  inboxItems(waiting, viewer, readAt).filter(({ source }) =>
    settledInInbox.has(source.type)
  );

const InboxRow = ({ item }: { item: InboxItem }) => {
  const { t, i18n } = useLingui();
  const { title } = item;
  return (
    <li className="flex min-h-14 items-center gap-3 border-t px-4 py-2">
      <ItemMark item={item} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-muted-foreground text-xs">
          {i18n._(kindLabel[item.kind])}
        </span>
        <span className="truncate">{title}</span>
      </div>
      <Link
        aria-label={t`Open in the inbox: ${title}`}
        className={buttonVariants({ size: "xs" })}
        search={{ item: item.id }}
        to="/inbox"
      >
        <Trans>Open</Trans>
      </Link>
    </li>
  );
};

/** The group of them under what waits elsewhere; nothing while none waits. */
export const InboxGroup = ({ items }: { items: readonly InboxItem[] }) => {
  const { t } = useLingui();
  if (items.length === 0) {
    return null;
  }
  return (
    <DashboardGroup title={t`In your inbox`}>
      <ul aria-label={t`In your inbox`}>
        {items.map((item) => (
          <InboxRow item={item} key={item.id} />
        ))}
      </ul>
    </DashboardGroup>
  );
};
