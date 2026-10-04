import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@grasp-os/ui/components/sidebar";
import { Trans } from "@lingui/react/macro";
import { Link, useMatchRoute, useRouter } from "@tanstack/react-router";
import { LayoutDashboardIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { readPendingRequests } from "../activity/pending.tsx";
import { integrationsOf } from "../connections/integrations.ts";
import { readWithin } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { useCore } from "../use-core.ts";
import { toReconnect } from "./to-do.tsx";

// The nav's way to the dashboard, with how many things wait on the person
// (as the prototype's badge, `app-sidebar.tsx`): changes to confirm,
// unread failed workflows, connections to sign in to again and, for
// admins, permission requests. Read again on every other page the person
// opens; nothing is marked read by counting.

/** A count, or none when core couldn't say. Outside the component, as the React Compiler can't compile `try`. */
const countOf = async (count: Promise<number>): Promise<number | undefined> => {
  try {
    return await count;
  } catch {
    return undefined;
  }
};

/** How many things wait on the person; `undefined` when core could say none of it. */
const readCount = async (
  core: CoreConnection,
  identity: Identity
): Promise<number | undefined> => {
  const counts = await Promise.all([
    countOf(
      readWithin(core, async (session) => {
        const held = await session.pendingActions.list();
        return held.length;
      })
    ),
    countOf(
      readWithin(core, async (session) => {
        const { unread } = await session.notifications.list();
        return unread;
      })
    ),
    countOf(
      readWithin(core, async (session) => {
        const [catalog, connections] = await Promise.all([
          session.connections.catalog(),
          session.connections.list(),
        ]);
        return toReconnect(
          integrationsOf(catalog.entries, connections),
          identity
        ).length;
      })
    ),
    isAdmin(identity.role)
      ? countOf(
          readWithin(core, async (session) => {
            const { requests } = await readPendingRequests(session);
            return requests.length;
          })
        )
      : 0,
  ]);
  const known = counts.filter((count) => count !== undefined);
  return known.length === 0
    ? undefined
    : known.reduce((total, count) => total + count, 0);
};

/** The sidebar's Dashboard entry, with how many things wait. */
export const DashboardItem = ({ identity }: { identity: Identity }) => {
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
      const count = await readCount(core, identity);
      if (mine === latest) {
        setWaiting(count);
      }
    };
    void read();
    // Again once another page has loaded, and after a change on this one
    // (the dashboard reads again after each); not when only the search
    // changes.
    const unsubscribe = router.subscribe("onResolved", ({ pathChanged }) => {
      if (pathChanged) {
        void read();
      }
    });
    return () => {
      // Nothing read after this is shown.
      latest += 1;
      unsubscribe();
    };
  }, [router, core, identity]);
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
            {waiting}
            <span className="sr-only">
              {" "}
              <Trans>waiting</Trans>
            </span>
          </SidebarMenuBadge>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};
