import { isAdmin } from "@grasp-os/shared/roles";
import { createFileRoute } from "@tanstack/react-router";

import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import {
  SettingsError,
  SettingsLoading,
  SettingsSection,
} from "../settings/settings-parts.tsx";
import { StephenSettings } from "../settings/stephen-settings.tsx";

// Settings › Stephen, for admins: who can reach the company's assistant in
// its chat apps and what he may do for whom (settings/stephen-settings.tsx).
// Grasp staff read it; only the company's own admins change it, as core
// checks on every call.

const StephenPage = () => {
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  if (page.state !== "ready") {
    return (
      <SettingsSection title="Stephen">
        <NotLoadedState heading="h3" page={page} />
      </SettingsSection>
    );
  }
  return (
    <StephenSettings
      classes={page.data.classes}
      editable={isAdmin(identity.role) && !identity.staff}
      reach={page.data.reach}
    />
  );
};

export const Route = createFileRoute("/_shell/settings/stephen")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: StephenPage,
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session) => {
      const [reach, classes] = await Promise.all([
        session.connections.stephenReach(),
        session.connections.toolClasses(),
      ]);
      return { reach, classes };
    }),
});
