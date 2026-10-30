import type { DecisionView } from "@grasp-os/shared/decisions";
import {
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@grasp-os/ui/components/sidebar";
import { Plural, Trans } from "@lingui/react/macro";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";

import { readWithin } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { useFrameRead } from "../frame/frame-read.ts";

// The nav's way to Workflows, with how many workflows need the person, as
// the prototype's badge (`components/app-sidebar.tsx`, `needsYou` in
// `lib/builder.ts`): each workflow once, however many of its runs ask.
// What needs them today is a decision of a run waiting for their answer;
// a change waiting for its test and approval, and a workflow in testing,
// join it with the workflow lifecycle (GRA-512). Read again as the
// Dashboard's count is (frame/frame-read.ts): after every change on a page,
// and on the way to another once the count is older than half a minute.

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

/** The sidebar's Workflows entry, with how many workflows need the person. */
export const WorkflowsItem = () => {
  const matchRoute = useMatchRoute();
  const { value: waiting } = useFrameRead(readCount);
  const shown = waiting !== undefined && waiting > 0;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={matchRoute({ to: "/workflows", fuzzy: true }) !== false}
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
    </SidebarMenuItem>
  );
};
