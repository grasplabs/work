import { canBuild } from "@grasp-os/shared/roles";
import { Button } from "@grasp-os/ui/components/button";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { LoadingLines, PageNotLoaded } from "../frame/page-states.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { MakeSomethingLink } from "../make/make-link.tsx";
import {
  readOverview,
  readTools,
  readTriggers,
} from "../workflows/overview.ts";
import type { TriggersByWorkflow } from "../workflows/overview.ts";
import { WorkflowRows } from "../workflows/workflow-rows.tsx";

// Everything that runs on its own, in one place: every workflow the
// person has a role in, as rows gathered by the phase each stands in
// (workflows/workflow-rows.tsx), those that need the reader first. Their
// runs are a page of their own (Workflows › Runs), a button away in the
// heading, beside the page's action: a new workflow.

/**
 * What stands beside the rows (the tools each workflow reaches, what
 * starts it), once its read answers. The loader starts these reads on
 * every run of it and never waits for them: a slow one keeps nobody from
 * their workflows.
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
      <Button asChild size="sm" variant="outline">
        <Link to="/workflows/runs">{t`Runs`}</Link>
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
  const tools = useLater(page.tools);
  const triggers = useLater(page.triggers);
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
          rows={page.overview.data}
          tools={tools}
          triggers={triggers}
        />
      </Page>
    </>
  );
};

/**
 * The workflows before they are read: the bar, the heading with its real
 * actions (so on a phone, where they wrap under the title, the rows stand
 * where they will), and the rows waiting as lines.
 */
const WorkflowsPending = () => {
  const { t } = useLingui();
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Workflows` }]} />
      <Page>
        <PageHeading action={<WorkflowsActions />} title={t`Workflows`} />
        <LoadingLines lines={6} />
      </Page>
    </>
  );
};

const noTriggers: TriggersByWorkflow = new Map();

export const Route = createFileRoute("/_shell/workflows/")({
  pendingComponent: WorkflowsPending,
  loader: async ({ context: { core } }) => {
    // Not awaited: the tools stand beside a workflow, and arrive after.
    const tools = readTools(core);
    const overview = await readOverview(core);
    // Nor these: what starts each workflow, read once the rows name them.
    const triggers =
      overview.state === "ready"
        ? readTriggers(
            core,
            overview.data.map(({ id }) => id)
          )
        : Promise.resolve(noTriggers);
    return { overview, tools, triggers };
  },
  component: Workflows,
});
