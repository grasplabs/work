import { createFileRoute, redirect } from "@tanstack/react-router";

// What core tells the person is on the dashboard now: an old link to the
// notifications, from mail, still leads there.
export const Route = createFileRoute("/_shell/notifications")({
  beforeLoad: () => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({ to: "/dashboard", replace: true });
  },
});
