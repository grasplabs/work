import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";

import { Button } from "../grasp/button/index.ts";
import { Item } from "../grasp/item/index.ts";
import { kindLabel, kindMark } from "../inbox/inbox-kind.tsx";
import { inboxItems } from "../inbox/items.ts";
import type { InboxItem, InboxSource } from "../inbox/items.ts";
import { DashboardGroup } from "./dashboard-card.tsx";
import type { Viewer, Waiting } from "./waiting.ts";

// What waits on the person that only the inbox settles: versions of
// workflows asked to go live, decisions runs wait on, starts of
// workflows their chats' agents asked for, questions of the brain asked of
// them, schedules that stopped, mailboxes or drives connect stopped hearing
// for their triggers, workflows' bindings that wait on an admin, and
// packages revoked as malware. The nav's count holds them, so the dashboard
// lists them too, each a way to its item in the inbox, where it is decided.

/** What the inbox settles and the dashboard has no card of its own for. */
const settledInInbox = new Set<InboxSource["type"]>([
  "workflowGoLive",
  "decision",
  "heldStart",
  "asked",
  "stopped",
  "stoppedEvents",
  "appMessage",
  "bindings",
  "packageNotice",
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

/** One of them, by its kind's icon and name, with the way to it in the inbox. */
const InboxRow = ({ item }: { item: InboxItem }) => {
  const { t, i18n } = useLingui();
  const { title } = item;
  return (
    <Item
      actions={
        <Button
          render={
            <Link
              aria-label={t`Open in the inbox: ${title}`}
              search={{ item: item.id }}
              to="/inbox"
            />
          }
          size="xs"
        >
          {t`Open`}
        </Button>
      }
      description={i18n._(kindLabel[item.kind])}
      icon={kindMark[item.kind]}
      title={title}
    />
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
      {items.map((item) => (
        <InboxRow item={item} key={item.id} />
      ))}
    </DashboardGroup>
  );
};
