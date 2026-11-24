import { isAdmin } from "@grasp-os/shared/roles";
import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Settings opens on the workspace, as in the prototype, for admins; on the
 * person's own profile, the one section everyone has, for everyone else.
 */
export const Route = createFileRoute("/_shell/settings/")({
  beforeLoad: ({ context: { identity } }) => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({
      replace: true,
      to: isAdmin(identity.role) ? "/settings/workspace" : "/settings/profile",
    });
  },
});
