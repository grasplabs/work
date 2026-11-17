import type { Identity } from "@grasp-os/shared/rpc";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Link, useLocation } from "@tanstack/react-router";

import type { CoreConnection } from "../core-connection.ts";
import { readWaiting } from "../dashboard/read-dashboard.ts";
import { formatAge } from "../format.ts";
import { useFrameRead } from "../frame/frame-read.ts";
import type { IconData } from "../grasp/icons/index.ts";
import {
  AppPanels,
  Bell,
  Brain,
  People,
  Question,
  Workflow,
} from "../grasp/icons/index.ts";
import type { SidebarGroup, SidebarRow } from "../grasp/sidebar/index.ts";
import { kindMark } from "./inbox-kind.tsx";
import { groupLabel, groupOrder } from "./inbox-page.tsx";
import { groupOf, inboxItems, unread } from "./items.ts";
import type { Group, InboxItem } from "./items.ts";

// The sidebar's Inbox view: the inbox's own navigation. First its views,
// named and ordered as the inbox's filter names them (inbox-page.tsx), each
// counting what needs the person and leading to the inbox with that view
// open (`/inbox?group=`); the onboarding's interviews as their own row while
// they run; then the few items that have waited longest, each to its place
// (`/inbox?item=`). Switching the sidebar to this view doesn't navigate: a
// glance at what waits keeps the page the person is on; a row does.
//
// What waits is read where the frame reads its counts (frame/frame-read.ts),
// without marking a notification read (only the inbox and the dashboard,
// which show them whole, do that). The counted items (what needs the
// person) are the bell's dot and the Dashboard row's count, so the view and
// the counts never disagree.

/** Each view's icon: what its items are about. */
const groupIcon: Record<Group, IconData> = {
  all: Bell,
  asked: Question,
  brain: Brain,
  outcomes: Question,
  workflows: Workflow,
  apps: AppPanels,
};

/** How many of the items that waited longest the view lists. */
const longestShown = 3;

/**
 * Everything the read found, calm items too (the interviews while nothing
 * in them needs the admin), by the counted list the frame gets: the frame
 * passes that list back to {@link useInboxGroups}, which needs the rest.
 */
const everythingOf = new WeakMap<readonly InboxItem[], InboxItem[]>();

/** The frame's read of what waits, one for each person who signs in. */
const reads = new WeakMap<
  Identity,
  (core: CoreConnection) => Promise<InboxItem[] | undefined>
>();

/**
 * What waits on `identity` and needs them, read without marking anything
 * read; none when core couldn't say any of it (the counts then show
 * nothing, as before).
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
    const everything = inboxItems(waiting, identity, new Date().toISOString());
    // What is only to follow isn't counted.
    const counted = everything.filter(({ calm }) => calm !== true);
    everythingOf.set(counted, everything);
    // Nothing read and something unread: core couldn't say, so say nothing.
    return everything.length === 0 && unread(waiting).length > 0
      ? undefined
      : counted;
  };
  reads.set(identity, read);
  return read;
};

/** What waits on the person and needs them; `undefined` until core says, or while `enabled` is false. */
export const useWaitingItems = (
  identity: Identity,
  enabled: boolean
): InboxItem[] | undefined => useFrameRead(readFor(identity), enabled).value;

/** The oldest first; an item with no date (nobody was asked) last. */
const byAge = (a: InboxItem, b: InboxItem): number => {
  if (a.date === "" || b.date === "") {
    return Number(a.date === "") - Number(b.date === "");
  }
  return a.date.localeCompare(b.date);
};

/**
 * The Inbox view's groups from what {@link useWaitingItems} read: the views
 * and the interviews, then what waited longest; none while nothing waits
 * at all, when the sidebar's `empty` sentence shows.
 */
export const useInboxGroups = (
  items: readonly InboxItem[] | undefined
): SidebarGroup[] => {
  const { t, i18n } = useLingui();
  const { pathname, search } = useLocation();
  const waitedLabel = (duration: string): string => t`Waiting for ${duration}`;
  const waitingLabel = (count: number): string =>
    t`${plural(count, {
      one: "# thing waiting for you",
      other: "# things waiting for you",
    })}`;
  const everything =
    items === undefined ? [] : (everythingOf.get(items) ?? items);
  if (everything.length === 0) {
    return [];
  }
  const counted = items ?? [];
  const onInbox = pathname === "/inbox";
  const openItem = onInbox ? search.item : undefined;
  const openGroup = onInbox ? (search.group ?? "all") : undefined;

  const countOf = (group: Group): number =>
    counted.filter((item) => group === "all" || groupOf[item.kind] === group)
      .length;
  const present = groupOrder.filter((group) =>
    everything.some((item) => groupOf[item.kind] === group)
  );
  // One group is the whole inbox already: no row to say it twice.
  const views =
    present.length < 2 ? (["all"] as const) : (["all", ...present] as const);
  const viewRows: SidebarRow[] = views.map((group) => ({
    id: `view-${group}`,
    label: i18n._(groupLabel[group]),
    icon: groupIcon[group],
    count: countOf(group),
    countLabel: waitingLabel(countOf(group)),
    render: <Link search={group === "all" ? {} : { group }} to="/inbox" />,
    current: openGroup === group && openItem === undefined,
  }));

  const pinned = everything.find((item) => item.pinned === true);
  const pinnedRow: SidebarRow[] =
    pinned === undefined
      ? []
      : [
          {
            id: pinned.id,
            label: pinned.title,
            icon: People,
            ...(pinned.summary === undefined ? {} : { detail: pinned.summary }),
            render: <Link search={{ item: pinned.id }} to="/inbox" />,
            current: openItem === pinned.id,
          },
        ];

  const now = new Date();
  const longest = counted
    .filter((item) => item.pinned !== true)
    .toSorted(byAge)
    .slice(0, longestShown);
  const longestRows: SidebarRow[] = longest.map((item) => {
    const age = item.date === "" ? undefined : formatAge(item.date, now);
    return {
      id: item.id,
      label: item.context,
      icon: kindMark[item.kind],
      ...(age === undefined
        ? {}
        : { end: age.short, endLabel: waitedLabel(age.long) }),
      render: <Link search={{ item: item.id }} to="/inbox" />,
      current: openItem === item.id,
    };
  });

  return [
    { id: "inbox-views", rows: [...viewRows, ...pinnedRow] },
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
