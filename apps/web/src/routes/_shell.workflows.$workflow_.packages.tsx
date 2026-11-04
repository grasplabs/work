import { PageHeaderTitle } from "@grasp-os/ui/components/page-header";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";

import { PackageApprovals } from "../engines/package-approvals.tsx";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// One workflow's approved npm packages, under the workflow's own page, for
// its builders, who read, retire and revoke them: what an App's Packages
// section is for an App. Core says who may read it
// (`dependencies.approvals`) and who may end what it lists; anyone else is
// told the workflow isn't there.

const WorkflowPackages = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { workflow: id } = Route.useParams();
  if (page.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={[
          { label: t`Workflows`, to: "/workflows" },
          { label: t`Workflow packages` },
        ]}
        icon={WorkflowIcon}
        notFound={t`Workflow not found`}
        page={page}
      />
    );
  }
  const workflow = page.data.subject.name;
  return (
    <>
      <SiteHeader
        crumbs={[
          { label: t`Workflows`, to: "/workflows" },
          {
            label: workflow,
            to: "/workflows/$workflow",
            params: { workflow: id },
          },
          { label: t`Packages` },
        ]}
      />
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-7 text-sm">
        <div className="flex flex-col gap-0.5">
          <PageHeaderTitle>{t`Packages for ${workflow}`}</PageHeaderTitle>
          <p className="text-muted-foreground">
            <Trans>
              The packages approved for this workflow&apos;s calculations.
              Retire or revoke them here.
            </Trans>
          </p>
        </div>
        <PackageApprovals key={page.data.subject.id} listed={page.data} />
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/workflows/$workflow_/packages")({
  pendingComponent: PageLoading,
  component: WorkflowPackages,
  loader: async ({ context: { core }, params: { workflow } }) =>
    await loadFromCore(
      core,
      async (session) => await session.dependencies.approvals({ workflow })
    ),
});
