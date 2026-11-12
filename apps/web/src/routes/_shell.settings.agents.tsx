import { createFileRoute, redirect } from "@tanstack/react-router";

// Settings › Agents moved to a page of its own, beside Apps and Workflows
// (/agents). The old address still leads there, for links made before.

export const Route = createFileRoute("/_shell/settings/agents")({
  beforeLoad: () => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({ to: "/agents", replace: true });
  },
});
