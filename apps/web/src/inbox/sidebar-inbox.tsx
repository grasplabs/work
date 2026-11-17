import type { Identity } from "@grasp-os/shared/rpc";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Link, useLocation } from "@tanstack/react-router";

import type { CoreConnection } from "../core-connection.ts";
import { readWaiting } from "../dashboard/read-dashboard.ts";
import { useFrameRead } from "../frame/frame-read.ts";
import { Bell } from "../grasp/icons/index.ts";
import type { SidebarGroup } from "../grasp/sidebar/index.ts";
import { kindLabel } from "./inbox-kind.tsx";
import { groupOf, inboxItems, unread } from "./items.ts";
import type { Group, InboxItem } from "./items.ts";

// What waits on the person, as the sidebar's Inbox view lists it: the
// inbox's own items (items.ts), read as the inbox reads them but without
// marking a notification read (only the inbox and the dashboard, which
// show them whole, do that), where the frame reads its counts
// (frame/frame-read.ts). Their number is the bell's dot and the Dashboard
// row's count, so the list and the counts never disagree. Each item is a
// row to its place in the inbox, where it is settled; by the inbox's own
// groups when there are several, and a last row to the whole inbox.

/** The inbox's groups, under the names its filter gives them. */
const groupLabel: Record<Exclude<Group, "all">, MessageDescriptor> = {
  workflows: msg({ message: "Workflows", context: "inbox filter" }),
  asked: msg({ message: "Asked of you", context: "inbox filter" }),
  brain: msg({ message: "Open in the Brain", context: "inbox filter" }),
  apps: msg({ message: "Apps and connections", context: "inbox filter" }),
};

const groupOrder = ["asked", "brain", "workflows", "apps"] as const;

/** The frame's read of what waits, one for each person who signs in. */
const reads = new WeakMap<
  Identity,
  (core: CoreConnection) => Promise<InboxItem[] | undefined>
>();

/**
 * What waits on `identity`, read without marking anything read; none when
 * core couldn't say any of it (the counts then show nothing, as before).
 */
const readFor = (
  identity: Identity
): ((core: CoreConnection) => Promise<InboxItem[] | undefined>) => {
  const known = reads.get(identity);
  if (known !== undefined) {
    return known;
  }
  const read = async (core: CoreConnection) => {
    const waiting = await readWaiting(core, identity, {
      markShownRead: false,
    });
    const items = inboxItems(waiting, identity, new Date().toISOString());
    return items.length === 0 && unread(waiting).length > 0 ? undefined : items;
  };
  reads.set(identity, read);
  return read;
};

/** What waits on the person; `undefined` until core says, or while `enabled` is false. */
export const useWaitingItems = (
  identity: Identity,
  enabled: boolean
): InboxItem[] | undefined => useFrameRead(readFor(identity), enabled).value;

/**
 * The Inbox view's groups: each item a row to its place in the inbox, by
 * the inbox's groups when there are several, and a last row to the inbox;
 * none while nothing waits, when the sidebar's `empty` sentence shows.
 */
export const useInboxGroups = (
  items: readonly InboxItem[] | undefined
): SidebarGroup[] => {
  const { t, i18n } = useLingui();
  const { pathname, search } = useLocation();
  if (items === undefined || items.length === 0) {
    return [];
  }
  const chosen = pathname === "/inbox" ? search.item : undefined;
  const rowOf = (item: InboxItem) => ({
    id: item.id,
    label: item.context,
    detail: i18n._(kindLabel[item.kind]),
    render: <Link search={{ item: item.id }} to="/inbox" />,
    current: chosen === item.id,
  });
  const present = groupOrder.filter((group) =>
    items.some((item) => groupOf[item.kind] === group)
  );
  const grouped: SidebarGroup[] =
    present.length === 1
      ? [{ rows: items.map(rowOf) }]
      : present.map((group) => {
          const rows = items
            .filter((item) => groupOf[item.kind] === group)
            .map(rowOf);
          return {
            id: `inbox-${group}`,
            label: i18n._(groupLabel[group]),
            count: rows.length,
            rows,
          };
        });
  return [
    ...grouped,
    {
      rows: [
        {
          label: t`The whole inbox`,
          icon: Bell,
          render: <Link to="/inbox" />,
          current: pathname === "/inbox" && chosen === undefined,
        },
      ],
    },
  ];
};
