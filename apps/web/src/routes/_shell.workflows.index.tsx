import { canBuild } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { NotLoadedState } from "../frame/page-states.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { Button } from "../grasp/button/index.ts";
import { MakeSomethingLink } from "../make/make-link.tsx";
import { readOverview, readTools } from "../workflows/overview.ts";
import type { ToolsByWorkflow } from "../workflows/overview.ts";
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

const Workflows = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const tools = useTools(page.tools);
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Workflows` }]} />
      <Page>
        <PageHeading
          action={
            <>
              <Button render={<Link to="/workflows/runs" />} size="sm">
                {t`Runs`}
              </Button>
              {canBuild(identity.role) ? (
                <MakeSomethingLink kind="workflow" size="sm" />
              ) : null}
            </>
          }
          title={t`Workflows`}
        />
        {page.overview.state === "ready" ? (
          <WorkflowsByPhase rows={page.overview.data} tools={tools} />
        ) : (
          <NotLoadedState page={page.overview} />
        )}
      </Page>
    </>
  );
};

export const Route = createFileRoute("/_shell/workflows/")({
  loader: async ({ context: { core } }) => {
    // Not awaited: the tools stand beside a workflow, and arrive after.
    const tools = readTools(core);
    return { overview: await readOverview(core), tools };
  },
  component: Workflows,
});
