import { createFileRoute, redirect } from "@tanstack/react-router";

/** Settings opens on the person's own profile, the one section everyone has. */
export const Route = createFileRoute("/_shell/settings/")({
  beforeLoad: () => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({ to: "/settings/profile" });
  },
});
