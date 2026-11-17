import { isMemberAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { SectionCard } from "../grasp/section-card/index.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { AiProvidersSettings } from "../settings/ai-providers.tsx";
import { SpendCard } from "../settings/ai-spend.tsx";
import {
  SectionNotLoaded,
  SettingsError,
  SettingsLoading,
} from "../settings/section.tsx";

// Settings › AI and spend, for admins: the organization's own AI provider
// keys, the models its calls use (settings/ai-providers.tsx), and what they
// cost this month (settings/ai-spend.tsx). Grasp staff read it; only the
// organization's own admins change it, as core checks on every call. The
// old Models and AI spend pages send here
// (_shell.settings.models.tsx, _shell.settings.spend.tsx).

const AiProvidersPage = () => {
  const { t } = useLingui();
  const { page, spend, settings } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  if (page.state !== "ready") {
    return (
      <SectionCard title={t`AI and spend`}>
        <SectionNotLoaded page={page} />
      </SectionCard>
    );
  }
  return (
    <>
      <AiProvidersSettings
        editable={isMemberAdmin(identity)}
        listing={page.data}
      />
      <SpendCard settings={settings} spend={spend} />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/ai-providers")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: AiProvidersPage,
  loader: async ({ context: { core } }) => {
    const [page, spend, settings] = await Promise.all([
      loadFromCore(core, async (session) => await session.aiProviders.list()),
      loadFromCore(core, async (session) => await session.models.spend()),
      loadFromCore(core, async (session) => await session.models.settings()),
    ]);
    return { page, spend, settings };
  },
});
