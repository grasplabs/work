import { isMemberAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { NotLoadedState } from "../frame/page-states.tsx";
import { PageSkeletonSettings } from "../frame/skeletons/settings.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { AiProvidersSettings } from "../settings/ai-providers.tsx";
import { SpendCard } from "../settings/ai-spend.tsx";
import { SettingsError, SettingsGroup } from "../settings/section.tsx";

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
      <SettingsGroup title={t`AI and spend`}>
        <NotLoadedState heading="h3" page={page} />
      </SettingsGroup>
    );
  }
  const { providers, source } = page.data;
  // Nothing connected and not on Grasp's AI: the page is the way to connect
  // a provider. What was spent this month on a key since removed still
  // shows: nowhere else says it.
  const spent = spend.state === "ready" && spend.data.total > 0;
  const unanswered = providers.length === 0 && source !== "grasp" && !spent;
  return (
    <>
      <AiProvidersSettings
        editable={isMemberAdmin(identity)}
        listing={page.data}
      />
      {unanswered ? null : <SpendCard settings={settings} spend={spend} />}
    </>
  );
};

/** The providers, the models (default, fallbacks, add), then the month's spend. */
const AiProvidersPending = () => (
  <PageSkeletonSettings sections={[1, 3, { variant: "chart" }]} />
);

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
