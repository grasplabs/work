import {
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@grasp-os/ui/components/sidebar";
import { Plural, Trans } from "@lingui/react/macro";
import { Link, useMatchRoute, useRouter } from "@tanstack/react-router";
import { LayoutDashboardIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { readWithin } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { useCore } from "../use-core.ts";

// The nav's way to the dashboard, with how many things wait on the person
// (as the prototype's badge, `app-sidebar.tsx`): everything core's feed of
// what waits lists (`session.waiting`), the failed workflows, questions,
// stopped schedules and revoked packages among it only while unread. Read again on every other
// page the person opens and after every change on one; nothing is marked
// read by counting.

/** How many things wait on the person; `undefined` when core couldn't say. Outside the component, as the React Compiler can't compile `try`. */
const readCount = async (core: CoreConnection): Promise<number | undefined> => {
  try {
    return await readWithin(core, async (session) => {
      const { items, unreadNotifications } = await session.waiting.list();
      const notified = new Set([
        "failedRun",
        "openQuestion",
        "stoppedSchedule",
        "revokedPackage",
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

/** The sidebar's Dashboard entry, with how many things wait. */
export const DashboardItem = () => {
  const router = useRouter();
  const matchRoute = useMatchRoute();
  const core = useCore();
  const [waiting, setWaiting] = useState<number>();
  useEffect(() => {
    // Each read's number: only the latest one's count is shown.
    let latest = 0;
    const read = async (): Promise<void> => {
      latest += 1;
      const mine = latest;
      const count = await readCount(core);
      if (mine === latest) {
        setWaiting(count);
      }
    };
    void read();
    // Again once another page has loaded, and after a change on this one
    // (the page reads again, its address unchanged); not when only the
    // search changes, as a filter typed into does.
    const unsubscribe = router.subscribe(
      "onResolved",
      ({ pathChanged, hrefChanged }) => {
        if (pathChanged || !hrefChanged) {
          void read();
        }
      }
    );
    return () => {
      // Nothing read after this is shown.
      latest += 1;
      unsubscribe();
    };
  }, [router, core]);
  const shown = waiting !== undefined && waiting > 0;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={matchRoute({ to: "/dashboard" }) !== false}
        render={<Link to="/dashboard" />}
      >
        <LayoutDashboardIcon />
        <span>
          <Trans>Dashboard</Trans>
        </span>
        {/* Inside the link, so its name says how many wait. */}
        {shown ? (
          <SidebarMenuBadge className="top-1.5">
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
