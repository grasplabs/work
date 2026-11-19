import { canBuild } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { NotLoadedState } from "../frame/page-states.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { PageSkeletonTable } from "../grasp/blocks/page-skeleton-table/page-skeleton-table.tsx";
import { Button } from "../grasp/button/index.ts";
import { grouping, view } from "../grasp/data-table/index.ts";
import { MakeSomethingLink } from "../make/make-link.tsx";
import { readOverview, readTools } from "../workflows/overview.ts";
import type { OverviewRow, ToolsByWorkflow } from "../workflows/overview.ts";
import { WorkflowsByPhase } from "../workflows/workflows-table.tsx";

// Everything that runs on its own, in one place: every workflow the
// person has a role in, as one table gathered by the phase each stands in
// (workflows/workflows-table.tsx), those that need the reader first. Their
// runs are a page of their own (Workflows › Runs), a button away in the
// heading, beside the page's action: a new workflow.

/**
 * The tools each workflow reaches, once their read answers. The loader
 * starts it on every run of it, beside the rows' read, and never waits
 * for it: a slow read of them keeps nobody from their workflows.
 */
const useTools = (
  tools: Promise<ToolsByWorkflow>
): ToolsByWorkflow | undefined => {
  const [read, setRead] = useState<ToolsByWorkflow>();
  useEffect(() => {
    let current = true;
    const settle = async (): Promise<void> => {
      const answered = await tools;
      if (current) {
        setRead(answered);
      }
    };
    void settle();
    return () => {
      current = false;
    };
  }, [tools]);
  return read;
};

/**
 * The heading's actions: the runs, and a new workflow for who builds.
 * They need no data, so the pending page stands them too.
 */
const WorkflowsActions = () => {
  const { t } = useLingui();
  const { identity } = Route.useRouteContext();
  return (
    <>
      <Button render={<Link to="/workflows/runs" />} size="sm">
        {t`Runs`}
      </Button>
      {canBuild(identity.role) ? (
        <MakeSomethingLink kind="workflow" size="sm" />
      ) : null}
    </>
  );
};

const Workflows = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const tools = useTools(page.tools);
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Workflows` }]} />
      <Page>
        <PageHeading action={<WorkflowsActions />} title={t`Workflows`} />
        {page.overview.state === "ready" ? (
          <WorkflowsByPhase rows={page.overview.data} tools={tools} />
        ) : (
          <NotLoadedState page={page.overview} />
        )}
      </Page>
    </>
  );
};

/** Nothing to show in a cell while the rows are read. */
const none = (): string => "";

/**
 * The workflows before they are read: the bar, the header with its real
 * actions (so on a phone, where they wrap under the title, the table
 * stands where it will), and the table waiting in its own form, its
 * toolbar and head as the page's (workflows/workflows-table.tsx).
 */
const WorkflowsPending = () => {
  const { t } = useLingui();
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Workflows` }]} />
      <PageSkeletonTable<OverviewRow>
        actions={<WorkflowsActions />}
        descriptionLines={0}
        table={{
          label: t`Workflows`,
          pieces: [grouping, view],
          columns: [
            { key: "workflow", header: t`Workflow`, value: none },
            {
              key: "owner",
              header: t({
                message: "Owner",
                context: "column: who owns a workflow",
              }),
              value: none,
            },
            {
              key: "tools",
              header: t`Tools`,
              value: none,
              hideBelow: "phone",
            },
            {
              key: "runs",
              header: t`Runs a week`,
              value: none,
              align: "end",
              hideBelow: "phone",
            },
          ],
        }}
      />
    </>
  );
};

export const Route = createFileRoute("/_shell/workflows/")({
  pendingComponent: WorkflowsPending,
  loader: async ({ context: { core } }) => {
    // Not awaited: the tools stand beside a workflow, and arrive after.
    const tools = readTools(core);
    return { overview: await readOverview(core), tools };
  },
  component: Workflows,
});
