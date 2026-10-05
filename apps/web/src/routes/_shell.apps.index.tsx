import { createFileRoute, redirect } from "@tanstack/react-router";

// Apps are now engines: an old link still leads there.
export const Route = createFileRoute("/_shell/apps/")({
  beforeLoad: () => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({ to: "/engines", replace: true });
  },
});
