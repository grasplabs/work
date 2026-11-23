import { isMemberAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { AiProvidersSettings } from "../settings/ai-providers.tsx";
import { SpendCard } from "../settings/ai-spend.tsx";
import {
  SettingsError,
  SettingsGroup,
  SettingsPending,
  SettingsStack,
} from "../settings/section.tsx";

// Settings › AI and spend, for admins: the organization's own AI provider
// keys, the models its calls use (settings/ai-providers.tsx), and what they
// cost this month (settings/ai-spend.tsx). Grasp staff read it; only the
// organization's own admins change it, as core checks on every call.

const AiProvidersPage = () => {
  const { t } = useLingui();
  const { page, spend, settings } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  if (page.state !== "ready") {
    return (
      <SettingsGroup flush={false} title={t`AI and spend`}>
        <NotLoadedState heading="h3" page={page} />
      </SettingsGroup>
    );
  }
  const { providers, source } = page.data;
  // Nothing connected and not on Grasp's AI: nothing has been spent, and
  // the page is only the way to connect a provider.
  const unanswered = providers.length === 0 && source !== "grasp";
  return (
    <SettingsStack>
      <AiProvidersSettings
        editable={isMemberAdmin(identity)}
        listing={page.data}
      />
      {unanswered ? null : <SpendCard settings={settings} spend={spend} />}
    </SettingsStack>
  );
};

/** The providers, the models (default, fallbacks, add), then the month's spend. */
const AiProvidersPending = () => <SettingsPending groups={[1, 3, 4]} />;

export const Route = createFileRoute("/_shell/settings/ai-providers")({
  pendingComponent: AiProvidersPending,
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
