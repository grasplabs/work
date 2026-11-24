import { canBuild, isMemberAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";

import { PageNotLoaded } from "../frame/page-states.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { PageSkeletonList } from "../grasp/blocks/page-skeleton-list/page-skeleton-list.tsx";
import { Button } from "../grasp/button/index.ts";
import { MakeSomethingLink } from "../make/make-link.tsx";
import {
  readOverview,
  readTriggers,
  withTriggers,
} from "../workflows/overview.ts";
import type { TriggersByWorkflow } from "../workflows/overview.ts";
import { WorkflowRows } from "../workflows/workflow-rows.tsx";

// Everything that runs on its own, in one place: every workflow the
// person has a role in, as one table, those that need the reader first
// (workflows/workflow-rows.tsx). Their runs are a page of their own
// (Workflows › Runs), a button away in the heading, beside the page's
// action: a new workflow. What starts each workflow is read before the
// rows show, as it decides how each stands: live only where something can
// start it.

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
          admin={isMemberAdmin(identity)}
          builds={canBuild(identity.role)}
          rows={page.overview.data}
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
    const read = await readOverview(core);
    if (read.state !== "ready") {
      return { overview: read, triggers: noTriggers };
    }
    // What starts each workflow, read once the rows name them: it decides
    // how each stands, so the rows wait for it. Only where the reader
    // manages its triggers: core lists anyone else their own alone, which
    // would read as nothing starting it.
    const admin = isMemberAdmin(identity);
    const triggers = await readTriggers(
      core,
      read.data.flatMap(({ id, role }) =>
        admin || role === "builder" ? [id] : []
      )
    );
    const overview = {
      ...read,
      data: withTriggers(read.data, triggers, admin),
    };
    return { overview, triggers };
  },
  component: Workflows,
});
