import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The console's own front page, its list of clients, is gone: Grasp's
 * admin is the one place staff manage everything, so this opens it, for
 * good. On the admin's own hostname the Worker moves it before it gets
 * here (src/admin-host.ts). The route stays for the links that still name
 * it.
 */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw redirect({ to: "/admin", search: true, statusCode: 301 });
  },
});
