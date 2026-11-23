import { createFileRoute } from "@tanstack/react-router";

import { SettingsError } from "../settings/section.tsx";
import { TeamsPanel } from "../settings/teams.tsx";

// Settings › Teams, for the organization's own admins: their teams, and
// whom the directory leaves to place (settings/teams.tsx). Core refuses the
// teams to anyone else.

export const Route = createFileRoute("/_shell/settings/teams")({
  errorComponent: SettingsError,
  component: TeamsPanel,
});
