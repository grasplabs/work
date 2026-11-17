import { isMemberAdmin } from "@grasp-os/shared/roles";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { SettingsError, SettingsLoading } from "../settings/section.tsx";
import {
  readOutcomes,
  UnknownOutcomes,
} from "../settings/unknown-outcomes.tsx";

// Settings → Unknown outcomes, for the organization's own admins: every
// person's open calls of unknown outcome (settings/unknown-outcomes.tsx).
// Core checks the role on every read.

const UnknownOutcomesPage = () => (
  <UnknownOutcomes page={Route.useLoaderData()} />
);

export const Route = createFileRoute("/_shell/settings/outcomes")({
  // Only the organization's own admins list everyone's: anyone else who
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
  component: UnknownOutcomesPage,
  // Each page of the listing within its own few seconds, and no more pages once the page is left.
  loader: async ({ abortController, context: { core } }) =>
    await readOutcomes(core, abortController.signal),
});
