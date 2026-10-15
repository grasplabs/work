import { createFileRoute, redirect } from "@tanstack/react-router";

// Engines are now Domains: an old link still leads there.
export const Route = createFileRoute("/_shell/engines/")({
  beforeLoad: () => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({ to: "/domains", replace: true });
  },
});
