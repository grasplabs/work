import { canBuild, isMemberAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { PageNotLoaded } from "../frame/page-states.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { PageSkeletonList } from "../grasp/blocks/page-skeleton-list/page-skeleton-list.tsx";
import { Button } from "../grasp/button/index.ts";
import { MakeSomethingLink } from "../make/make-link.tsx";
import {
  readOverview,
  readTools,
  readTriggers,
  withTriggers,
} from "../workflows/overview.ts";
import type { TriggersByWorkflow } from "../workflows/overview.ts";
import { WorkflowRows } from "../workflows/workflow-rows.tsx";

// Everything that runs on its own, in one place: every workflow the
// person has a role in, as rows gathered by the phase each stands in
// (workflows/workflow-rows.tsx), those that need the reader first. Their
// runs are a page of their own (Workflows › Runs), a button away in the
// heading, beside the page's action: a new workflow. What starts each
// workflow is read before the rows show, as it decides how each stands:
// live only where something can start it.

/**
 * What stands beside the rows (the tools each workflow reaches), once its
 * read answers. The loader starts this read on every run of it and never
 * waits for it: a slow one keeps nobody from their workflows.
 */
const useLater = <T,>(later: Promise<T>): T | undefined => {
  const [read, setRead] = useState<T>();
  useEffect(() => {
    let current = true;
    const settle = async (): Promise<void> => {
      const answered = await later;
      if (current) {
        setRead(answered);
      }
    };
    void settle();
    return () => {
      current = false;
    };
  }, [later]);
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
  const { identity } = Route.useRouteContext();
  const tools = useLater(page.tools);
  // The rows are the page: without them the failure stands for all of it,
  // under the bar, not as a box under a heading with nothing to head.
  if (page.overview.state !== "ready") {
    return (
      <PageNotLoaded crumbs={[{ label: t`Workflows` }]} page={page.overview} />
    );
  }
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Workflows` }]} />
      <Page>
        <PageHeading action={<WorkflowsActions />} title={t`Workflows`} />
        <WorkflowRows
          builds={canBuild(identity.role)}
          rows={page.overview.data}
          tools={tools}
          triggers={page.triggers}
        />
      </Page>
    </>
  );
};

/**
 * The workflows before they are read: the bar, the header with its real
 * actions (so on a phone, where they wrap under the title, the rows stand
 * where they will), and the rows waiting in their own form.
 */
const WorkflowsPending = () => {
  const { t } = useLingui();
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Workflows` }]} />
      <PageSkeletonList
        actions={<WorkflowsActions />}
        descriptionLines={0}
        iconLook="inline"
        rows={6}
        size="sm"
        variant="items"
      />
    </>
  );
};

const noTriggers: TriggersByWorkflow = new Map();

export const Route = createFileRoute("/_shell/workflows/")({
  pendingComponent: WorkflowsPending,
  loader: async ({ context: { core, identity } }) => {
    // Not awaited: the tools stand beside a workflow, and arrive after.
    const tools = readTools(core);
    const read = await readOverview(core);
    if (read.state !== "ready") {
      return { overview: read, tools, triggers: noTriggers };
    }
    // What starts each workflow, read once the rows name them: it decides
    // how each stands, so the rows wait for it.
    const triggers = await readTriggers(
      core,
      read.data.map(({ id }) => id)
    );
    const overview = {
      ...read,
      data: withTriggers(read.data, triggers, isMemberAdmin(identity)),
    };
    return { overview, tools, triggers };
  },
  component: Workflows,
});
