import { isAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { PendingApprovals, readPendingRequests } from "../activity/pending.tsx";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import {
  SettingsBody,
  SettingsError,
  SettingsLoading,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// Settings → Pending approvals, for admins: the permission requests that
// wait for an admin, until the Dashboard holds what waits on you (GRA-194).
// Core checks the role on every call.

const Approvals = () => {
  const { t } = useLingui();
  const pending = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  return (
    <SettingsSection
      description={t`What engines and agents ask to be allowed to do, waiting for an admin.`}
      title={t`Pending approvals`}
    >
      <SettingsBody>
        {pending.state === "ready" ? (
          <PendingApprovals
            decides={isAdmin(identity.role) && !identity.staff}
            pending={pending.data}
          />
        ) : (
          <NotLoadedState heading="h3" page={pending} />
        )}
      </SettingsBody>
    </SettingsSection>
  );
};

export const Route = createFileRoute("/_shell/settings/approvals")({
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, readPendingRequests),
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: Approvals,
});
