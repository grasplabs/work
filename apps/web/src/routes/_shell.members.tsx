import { createFileRoute, redirect } from "@tanstack/react-router";

/** Members moved into Settings; an old link still leads there. */
export const Route = createFileRoute("/_shell/members")({
  beforeLoad: () => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({ to: "/settings/members", replace: true });
  },
});
