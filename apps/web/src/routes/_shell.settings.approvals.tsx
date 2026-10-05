import { createFileRoute, redirect } from "@tanstack/react-router";

// Pending approvals moved from Settings to the dashboard, with everything
// else that waits on the person: an old link still leads there.
export const Route = createFileRoute("/_shell/settings/approvals")({
  beforeLoad: () => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({ to: "/dashboard", replace: true });
  },
});
