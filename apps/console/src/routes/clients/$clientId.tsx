import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The console's own client page is gone: everything it showed and did is
 * the organization's Setup in the admin. For good, with whatever the
 * address asked besides (src/admin-host.ts moves it first on the admin's
 * own hostname). The route stays for the links that still name it.
 */
export const Route = createFileRoute("/clients/$clientId")({
  beforeLoad: ({ params }) => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({
      to: "/admin/organizations/$clientId/setup",
      params: { clientId: params.clientId },
      search: true,
      statusCode: 301,
    });
  },
});
