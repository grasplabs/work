import { isMemberAdmin } from "@grasp-os/shared/roles";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { loadFromCore } from "../load-from-core.tsx";
import { EventSourcesSettings } from "../settings/event-sources.tsx";
import { SettingsError, SettingsLoading } from "../settings/settings-parts.tsx";

// Settings › Webhooks, for the organization's own admins: the event
// sources outside systems send events to (settings/event-sources.tsx),
// which stays mounted whatever the list's read came to, so a secret just
// shown outlives a read after it that fails. Core checks the role on
// every call.

const WebhooksPage = () => (
  <EventSourcesSettings page={Route.useLoaderData()} />
);

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
