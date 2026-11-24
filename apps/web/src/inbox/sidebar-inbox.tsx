import type { Identity } from "@grasp-os/shared/rpc";
import { BellIcon } from "@grasp-os/ui/lib/icons";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Link, useLocation } from "@tanstack/react-router";

import type { CoreConnection } from "../core-connection.ts";
import { formatAge } from "../format.ts";
import { useFrameRead } from "../frame/frame-read.ts";
import type { SidebarGroupEntry, SidebarRow } from "../frame/sidebar.tsx";
import { kindMark } from "./inbox-kind.tsx";
import { inboxItems, unread } from "./items.ts";
import type { InboxItem } from "./items.ts";
import { readWaiting } from "./read-waiting.ts";
import type { Waiting } from "./waiting.ts";

// The sidebar's Inbox view, as the reference's (#2503's
// inbox/sidebar-inbox.tsx): the inbox's own navigation. First All, the
// inbox, with how many things need the person; then the few items that
// have waited longest, each to its place (`/inbox?item=`). The reference
// also lists a row per group of the inbox's filter (`/inbox?group=`); the
// inbox has no groups since #2659, so there is no view of one to lead to.
//
// What waits is read where the frame reads its counts (frame/frame-read.ts),
// without marking a notification read (only the inbox, which shows them
// whole, does that), and of the notifications only those still unread
// count. The counted items are the Inbox tab's dot too, so the view and the
// dot never disagree.

/** How many of the items that waited longest the view lists. */
const longestShown = 3;

/** What waits, with the notifications already read left out: they need nothing. */
const unreadOnly = (waiting: Waiting): Waiting =>
  waiting.notifications.state === "ready"
    ? {
        ...waiting,
        notifications: {
          ...waiting.notifications,
          data: {
            ...waiting.notifications.data,
            page: {
              ...waiting.notifications.data.page,
              notifications:
                waiting.notifications.data.page.notifications.filter(
                  ({ read }) => !read
                ),
            },
          },
        },
      }
    : waiting;

/** The frame's read of what waits, one for each person who signs in. */
const reads = new WeakMap<
  Identity,
  (core: CoreConnection) => Promise<InboxItem[] | undefined>
>();

/**
 * What waits on `identity` and needs them, read without marking anything
 * read; none when core couldn't say any of it (the dot then shows nothing).
 */
const readFor = (
  identity: Identity
): ((core: CoreConnection) => Promise<InboxItem[] | undefined>) => {
  const known = reads.get(identity);
  if (known !== undefined) {
    return known;
  }
  const read = async (
    core: CoreConnection
  ): Promise<InboxItem[] | undefined> => {
    let said: InboxItem[] | undefined;
    try {
      const waiting = await readWaiting(core, identity, {
        markShownRead: false,
      });
      const items = inboxItems(
        unreadOnly(waiting),
        identity,
        new Date().toISOString()
      );
      // Nothing read and something unread: core couldn't say, so say nothing.
      if (items.length > 0 || unread(waiting).length === 0) {
        said = items;
      }
    } catch {
      // Core couldn't be read: say nothing.
    }
    return said;
  };
  reads.set(identity, read);
  return read;
};

/** What waits on the person and needs them; `undefined` until core says, or while `enabled` is false. */
export const useWaitingItems = (
  identity: Identity,
  enabled: boolean
): InboxItem[] | undefined => useFrameRead(readFor(identity), enabled).value;

/** How many things wait in a view, in words, for a screen reader. */
const waitingLabel = (count: number): string =>
  plural(count, {
    one: "# thing waiting for you",
    other: "# things waiting for you",
  });

/** The oldest first; an item with no date last. */
const byAge = (a: InboxItem, b: InboxItem): number => {
  if (a.date === "" || b.date === "") {
    return Number(a.date === "") - Number(b.date === "");
  }
  return a.date.localeCompare(b.date);
};

/**
 * The Inbox view's groups from what {@link useWaitingItems} read: All,
 * then what waited longest; none while nothing waits, when the
 * sidebar's `empty` sentence shows.
 */
export const useInboxGroups = (
  items: readonly InboxItem[] | undefined
): SidebarGroupEntry[] => {
  const { t } = useLingui();
  const { pathname, search } = useLocation();
  const waitedLabel = (duration: string): string => t`Waiting for ${duration}`;
  const counted = items ?? [];
  if (counted.length === 0) {
    return [];
  }
  const onInbox = pathname === "/inbox";
  const asked: { item?: unknown } = search;
  const openItem = onInbox ? asked.item : undefined;
  const all: SidebarRow = {
    id: "view-all",
    label: t({ message: "All", context: "inbox filter, short" }),
    icon: BellIcon,
    count: counted.length,
    countLabel: waitingLabel(counted.length),
    render: (look) => <Link {...look} to="/inbox" />,
    current: onInbox && openItem === undefined,
  };

  const now = new Date();
  const longest = counted.toSorted(byAge).slice(0, longestShown);
  const longestRows: SidebarRow[] = longest.map((item) => {
    const age = item.date === "" ? undefined : formatAge(item.date, now);
    return {
      id: item.id,
      label: item.context,
      icon: kindMark[item.kind],
      ...(age === undefined
        ? {}
        : { end: age.short, endLabel: waitedLabel(age.long) }),
      render: (look) => (
        <Link {...look} search={{ item: item.id }} to="/inbox" />
      ),
      current: openItem === item.id,
    };
  });

  return [
    { id: "inbox-views", rows: [all] },
    ...(longestRows.length === 0
      ? []
      : [
          {
            id: "inbox-longest",
            label: t({
              message: "Waiting longest",
              context: "sidebar: the inbox items that have waited longest",
            }),
            rows: longestRows,
          },
        ]),
  ];
};
