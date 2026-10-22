/**
 * Grasp's admin on a hostname of its own (`admin.<domain>`), served by the
 * console's Worker like every other page: the hostname only decides where
 * a staff member lands. Both hostnames sit behind the same Access
 * application, so the Access check (src/access.ts) is the same on either.
 *
 * Without `ADMIN_HOST` nothing changes: the admin stays at `/admin`.
 */

/** What the redirect reads from the console's env. */
export interface AdminHostEnv {
  /** The admin's own hostname, e.g. `admin.grasp.example`. */
  ADMIN_HOST?: string;
}

const adminPath = "/admin";

/** Where TanStack Start serves server functions (its default base). */
const serverFunctionBase = "/_serverFn";

const isAdminPath = (pathname: string): boolean =>
  pathname === adminPath || pathname.startsWith(`${adminPath}/`);

const redirectTo = (location: string): Response =>
  new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store" },
  });

/**
 * Where a page request should go instead, or null to serve it here:
 * - the admin's hostname's front page is the admin's;
 * - the admin's pages on any other hostname move to the admin's.
 * Only page loads (GET, HEAD) move; server functions and anything that
 * changes something are answered where they're asked.
 */
export const adminHostRedirect = (
  request: Request,
  env: AdminHostEnv
): Response | null => {
  const adminHost = (env.ADMIN_HOST ?? "").toLowerCase();
  if (adminHost === "" || !["GET", "HEAD"].includes(request.method)) {
    return null;
  }
  const url = new URL(request.url);
  if (url.pathname.startsWith(serverFunctionBase)) {
    return null;
  }
  if (url.hostname === adminHost) {
    return url.pathname === "/"
      ? redirectTo(`${adminPath}${url.search}`)
      : null;
  }
  if (isAdminPath(url.pathname)) {
    return redirectTo(`https://${adminHost}${url.pathname}${url.search}`);
  }
  return null;
};
