import { isMemberAdmin } from "@grasp-os/shared/roles";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { SettingsError } from "../settings/section.tsx";
import { TeamsPanel } from "../settings/teams.tsx";

// Settings › Teams, for the organization's own admins: their teams, and
// whom the directory leaves to place (settings/teams.tsx). Core refuses the
// teams to anyone else.

export const Route = createFileRoute("/_shell/settings/teams")({
  // Anyone else who follows a link here goes to their own settings: core
  // refuses them all the same, this only spares them a refusal.
  beforeLoad: ({ context: { identity } }) => {
    if (!isMemberAdmin(identity)) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/settings/profile", replace: true });
    }
  },
  errorComponent: SettingsError,
  component: TeamsPanel,
});
