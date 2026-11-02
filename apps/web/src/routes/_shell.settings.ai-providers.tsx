import { isAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { AiProvidersSettings } from "../settings/ai-providers.tsx";
import {
  SettingsError,
  SettingsLoading,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// Settings › AI providers, for admins: the organization's own AI provider
// keys and the models its calls use (settings/ai-providers.tsx). Grasp
// staff read it; only the organization's own admins change it, as core
// checks on every call.

const AiProvidersPage = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  if (page.state !== "ready") {
    return (
      <SettingsSection title={t`AI providers`}>
        <NotLoadedState heading="h3" page={page} />
      </SettingsSection>
    );
  }
  return (
    <AiProvidersSettings
      editable={isAdmin(identity.role) && !identity.staff}
      listing={page.data}
    />
  );
};

export const Route = createFileRoute("/_shell/settings/ai-providers")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: AiProvidersPage,
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.aiProviders.list()
    ),
});
