import { isMemberAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { SectionCard } from "../grasp/section-card/index.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { ConnectConcept, concepts } from "../settings/ai-connect-concepts.tsx";
import type { Concept } from "../settings/ai-connect-concepts.tsx";
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
//
// On this branch alone, never merged: `?concept=a|b|c` shows one of three
// concepts for connecting the first provider (settings/ai-connect-concepts.tsx),
// and hides the Spend card while nothing is connected: at $0.00 it says
// nothing yet.

const AiProvidersPage = () => {
  const { t } = useLingui();
  const { page, spend, settings } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const { concept } = Route.useSearch();
  if (page.state !== "ready") {
    return (
      <SectionCard variant="grouped" density="compact" title={t`AI and spend`}>
        <SectionNotLoaded page={page} />
      </SectionCard>
    );
  }
  const { providers, source } = page.data;
  const unanswered = providers.length === 0 && source !== "grasp";
  return (
    <>
      <AiProvidersSettings
        editable={isMemberAdmin(identity)}
        listing={page.data}
        {...(concept === undefined
          ? {}
          : {
              renderConnect: (props) => (
                <ConnectConcept concept={concept} {...props} />
              ),
            })}
      />
      {concept !== undefined && unanswered ? null : (
        <SpendCard settings={settings} spend={spend} />
      )}
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/ai-providers")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: AiProvidersPage,
  validateSearch: (search: Record<string, unknown>): { concept?: Concept } => {
    const chosen = concepts.find((each) => each === search.concept);
    return chosen === undefined ? {} : { concept: chosen };
  },
  loader: async ({ context: { core } }) => {
    const [page, spend, settings] = await Promise.all([
      loadFromCore(core, async (session) => await session.aiProviders.list()),
      loadFromCore(core, async (session) => await session.models.spend()),
      loadFromCore(core, async (session) => await session.models.settings()),
    ]);
    return { page, spend, settings };
  },
});
