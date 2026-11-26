import { isMemberAdmin } from "@grasp-os/shared/roles";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { InterviewsPanel } from "../settings/interviews.tsx";
import { SettingsError } from "../settings/section.tsx";

// Settings › Interviews, for the organization's own admins: where the
// onboarding's interviews stand, team by team, and what of them needs the
// admin (settings/interviews.tsx). Core refuses it all to anyone who isn't
// an admin.

export const Route = createFileRoute("/_shell/settings/interviews")({
  // Anyone else who follows a link here goes to their own settings: core
  // refuses them all the same, this only spares them a refusal.
  beforeLoad: ({ context: { identity } }) => {
    if (!isMemberAdmin(identity)) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/settings/profile", replace: true });
    }
  },
  errorComponent: SettingsError,
  component: InterviewsPanel,
});
