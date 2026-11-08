import { isMemberAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { EventSourcesSettings } from "../settings/event-sources.tsx";
import {
  SettingsError,
  SettingsLoading,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// Settings › Webhooks, for the organization's own admins: the event
// sources outside systems send events to (settings/event-sources.tsx).
// Core checks the role on every call.

const WebhooksPage = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  if (page.state !== "ready") {
    return (
      <SettingsSection title={t`Webhooks`}>
        <NotLoadedState heading="h3" page={page} />
      </SettingsSection>
    );
  }
  return <EventSourcesSettings sources={page.data} />;
};

export const Route = createFileRoute("/_shell/settings/webhooks")({
  // Only the organization's own admins manage sources: anyone else who
  // follows a link here goes to their own settings. Core refuses them all
  // the same; this only spares them a refusal.
  beforeLoad: ({ context: { identity } }) => {
    if (!isMemberAdmin(identity)) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/settings/profile", replace: true });
    }
  },
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: WebhooksPage,
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.workflowResources.sources.list()
    ),
});
