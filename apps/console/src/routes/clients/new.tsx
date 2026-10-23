import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The console's own new-client form is gone: an organization is added in
 * the admin, which starts the same provisioning. For good, with whatever
 * the address asked besides (src/admin-host.ts moves it first on the
 * admin's own hostname).
 */
export const Route = createFileRoute("/clients/new")({
  beforeLoad: () => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({
      to: "/admin/new-organization",
      search: true,
      statusCode: 301,
    });
  },
});
