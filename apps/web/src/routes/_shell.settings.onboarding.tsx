import { createFileRoute, redirect } from "@tanstack/react-router";

// Settings, Onboarding, as it was: the interviews now stand under
// Settings › Interviews (settings/interviews.tsx), and an old link here
// leads there. That section sends on anyone it isn't for.

export const Route = createFileRoute("/_shell/settings/onboarding")({
  beforeLoad: () => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({ to: "/settings/interviews", replace: true });
  },
});
