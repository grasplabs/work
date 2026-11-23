import {
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@grasp-os/app-kit/components/sidebar";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { InboxIcon } from "lucide-react";

import { readWithin } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { useFrameRead } from "../frame/frame-read.ts";

// The nav's way to the inbox, with how many things wait on the person
// (as the prototype's badge, `app-sidebar.tsx`): everything core's feed of
// what waits lists (`session.waiting`), the failed workflows, questions,
// stopped schedules, sources and package notices among it only while
// unread. Read again after every change on a page, and on the way to
// another once the count is older than half a minute (frame/frame-read.ts);
// nothing is marked read by counting.

/** How many things wait on the person; `undefined` when core couldn't say. Outside the component, as the React Compiler can't compile `try`. */
const readCount = async (core: CoreConnection): Promise<number | undefined> => {
  try {
    return await readWithin(core, async (session) => {
      const { items, unreadNotifications } = await session.waiting.list();
      const notified = new Set([
        "failedRun",
        "openQuestion",
        "stoppedSchedule",
        "workflowChanged",
        "packageNotice",
        "stoppedEvents",
        "appMessage",
      ]);
      return (
        items.filter(({ kind }) => !notified.has(kind)).length +
        unreadNotifications
      );
    });
  } catch {
    return undefined;
  }
};

/** The sidebar's Inbox entry, with how many things wait. */
export const InboxNavItem = () => {
  const { t } = useLingui();
  const matchRoute = useMatchRoute();
  const { value: waiting } = useFrameRead(readCount);
  const shown = waiting !== undefined && waiting > 0;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={matchRoute({ to: "/inbox" }) !== false}
        render={<Link to="/inbox" />}
        tooltip={t`Inbox`}
      >
        <InboxIcon />
        <span>
          <Trans>Inbox</Trans>
        </span>
        {/* Inside the link, so its name says how many wait. */}
        {shown ? (
          <SidebarMenuBadge placement="inside">
            <span aria-hidden="true">{waiting}</span>
            <span className="sr-only">
              <Plural
                one="# thing waiting"
                other="# things waiting"
                value={waiting}
              />
            </span>
          </SidebarMenuBadge>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};
