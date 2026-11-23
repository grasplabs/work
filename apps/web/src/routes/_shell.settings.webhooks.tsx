import { createFileRoute } from "@tanstack/react-router";

import { loadFromCore } from "../load-from-core.tsx";
import {
  EventSourcesSettings,
  sourceStartsOf,
} from "../settings/event-sources.tsx";
import { SettingsError, SettingsPending } from "../settings/section.tsx";

// Settings › Incoming events (at /settings/webhooks, kept for links), for
// the organization's own admins: the event sources outside systems send
// events to (settings/event-sources.tsx), which stays mounted whatever the
// list's read came to, so a secret just shown outlives a read after it that
// fails. Core checks the role on every call.

const IncomingEventsPage = () => {
  const { sources, starts } = Route.useLoaderData();
  return <EventSourcesSettings page={sources} starts={starts} />;
};

/** The sources' card, as tall as its empty state. */
const IncomingEventsPending = () => <SettingsPending groups={[3]} />;

export const Route = createFileRoute("/_shell/settings/webhooks")({
  pendingComponent: IncomingEventsPending,
  errorComponent: SettingsError,
  component: IncomingEventsPage,
  loader: async ({ context: { core } }) => {
    const [sources, starts] = await Promise.all([
      loadFromCore(
        core,
        async (session) => await session.workflowResources.sources.list()
      ),
      // The workflows each source starts: read once for the page.
      sourceStartsOf(core),
    ]);
    return { sources, starts };
  },
});
