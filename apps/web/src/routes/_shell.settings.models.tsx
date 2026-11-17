import { createFileRoute, redirect } from "@tanstack/react-router";

// Settings › Models is part of AI and spend now
// (_shell.settings.ai-providers.tsx): an old link lands there.

export const Route = createFileRoute("/_shell/settings/models")({
  beforeLoad: () => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({ to: "/settings/ai-providers", replace: true });
  },
});
