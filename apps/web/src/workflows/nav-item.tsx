import type { DecisionView } from "@grasp-os/shared/decisions";
import {
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@grasp-os/ui/components/sidebar";
import { Plural, Trans } from "@lingui/react/macro";
import { Link, useMatchRoute, useRouter } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { readWithin } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { useCore } from "../use-core.ts";

// The nav's way to Workflows, with how many workflows need the person, as
// the prototype's badge (`components/app-sidebar.tsx`, `needsYou` in
// `lib/builder.ts`): each workflow once, however many of its runs ask.
// What needs them today is a decision of a run waiting for their answer;
// a change waiting for its test and approval, and a workflow in testing,
// join it with the workflow lifecycle (GRA-512). Read again as the
// Dashboard's count is (dashboard/nav-item.tsx): on every other page the
// person opens and after every change on one.

/** The workflow a decision's run belongs to: an App's, or an independent one. */
const workflowOf = (decision: DecisionView): string =>
  decision.workflowResource === undefined
    ? `app:${decision.app?.id ?? ""}:${decision.workflow}`
    : `resource:${decision.workflowResource.id}`;

/**
 * How many workflows need the person; `undefined` when core couldn't say.
 * Outside the component, as the React Compiler can't compile `try`.
 */
const readCount = async (core: CoreConnection): Promise<number | undefined> => {
  try {
    const waiting = await readWithin(
      core,
      async (session) => await session.decisions.waiting()
    );
    return new Set(waiting.map(workflowOf)).size;
  } catch {
    return undefined;
  }
};

/**
 * The sidebar's Workflows entry, with how many workflows need the person;
 * for owners and admins (`requests`), Stephen's requests under it while
 * the person is in Workflows.
 */
export const WorkflowsItem = ({ requests = false }: { requests?: boolean }) => {
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
  // As the prototype's: Requests is under Workflows while the person is
  // in them, and lit on its own there.
  const inWorkflows = matchRoute({ to: "/workflows", fuzzy: true }) !== false;
  const onRequests =
    matchRoute({ to: "/workflows/requests", fuzzy: true }) !== false;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={inWorkflows && !onRequests}
        render={<Link to="/workflows" />}
      >
        <WorkflowIcon />
        <span>
          <Trans>Workflows</Trans>
        </span>
        {/* Inside the link, so its name says how many need the person. */}
        {shown ? (
          <SidebarMenuBadge className="top-1.5">
            <span aria-hidden="true">{waiting}</span>
            <span className="sr-only">
              <Plural
                one="# workflow needs you"
                other="# workflows need you"
                value={waiting}
              />
            </span>
          </SidebarMenuBadge>
        ) : null}
      </SidebarMenuButton>
      {requests && inWorkflows ? (
        <SidebarMenuSub>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              isActive={onRequests}
              render={<Link to="/workflows/requests" />}
            >
              <span>
                <Trans context="Stephen's requests: the page">Requests</Trans>
              </span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        </SidebarMenuSub>
      ) : null}
    </SidebarMenuItem>
  );
};
