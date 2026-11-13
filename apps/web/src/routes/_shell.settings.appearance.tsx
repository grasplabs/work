import { createFileRoute } from "@tanstack/react-router";

import { BackdropSettings } from "../settings/backdrop-settings.tsx";
import { SettingsError } from "../settings/settings-parts.tsx";

// Settings → Appearance: how Grasp looks for this person. For now what
// stands behind Chat's own page (settings/backdrop-settings.tsx).

const Appearance = () => {
  const { identity } = Route.useRouteContext();
  return <BackdropSettings userId={identity.userId} />;
};

export const Route = createFileRoute("/_shell/settings/appearance")({
  errorComponent: SettingsError,
  component: Appearance,
});
