import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { PackageApprovals } from "../engines/package-approvals.tsx";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import {
  SettingsError,
  SettingsLoading,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// One workflow's approved npm packages, for its builders (to read) and
// whoever may approve packages (to read, retire and revoke): what an App's
// Packages tab is for an App, since a workflow has no page of its own.
// Core says who may read it (`dependencies.approvals`) and who may end
// what it lists; anyone else is told the workflow isn't there.

const WorkflowPackages = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const workflow = page.state === "ready" ? page.data.subject.name : "";
  return (
    <SettingsSection
      description={
        <Trans>
          The packages approved for this workflow&apos;s calculations. Retire or
          revoke them here.
        </Trans>
      }
      title={
        page.state === "ready"
          ? t`Packages for ${workflow}`
          : t`Workflow packages`
      }
    >
      {page.state === "ready" ? (
        <div className="border-t px-5 py-4">
          <PackageApprovals key={page.data.subject.id} listed={page.data} />
        </div>
      ) : (
        <div className="border-t">
          <NotLoadedState heading="h3" page={page} />
        </div>
      )}
    </SettingsSection>
  );
};

export const Route = createFileRoute(
  "/_shell/settings/packages/workflows/$workflow"
)({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: WorkflowPackages,
  loader: async ({ context: { core }, params: { workflow } }) =>
    await loadFromCore(
      core,
      async (session) => await session.dependencies.approvals({ workflow })
    ),
});
