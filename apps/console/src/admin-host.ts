/**
 * Grasp's admin on a hostname of its own (`admin.<domain>`), served by the
 * console's Worker like every other page. The admin is the one place staff
 * manage everything, so every page load moves there: the console's
 * hostname only still answers what isn't a page (server functions, the
 * admin's MCP server, Discord's interactions) and what changes something.
 * Both hostnames sit behind the same Access application, so the Access
 * check (src/access.ts) is the same on either. The console's old pages
 * move to where they went first (src/moved-pages.ts), on either hostname.
 *
 * Without `ADMIN_HOST` nothing moves here: the admin stays at `/admin`.
 */

/** What the redirect reads from the console's env. */
export interface AdminHostEnv {
  /** The admin's own hostname, e.g. `admin.grasp.example`. */
  ADMIN_HOST?: string;
}

/**
 * What isn't a page and is answered where it's asked: TanStack Start's
 * server functions (its default base), the admin's MCP server
 * (src/admin/mcp.ts) and Discord's interactions (src/admin/discord.ts).
 */
const notPages = ["/_serverFn", "/mcp", "/discord/interactions"] as const;

const isUnder = (pathname: string, base: string): boolean =>
  pathname === base || pathname.startsWith(`${base}/`);

/**
 * Where a page request should go instead, or null to serve it here: on
 * any hostname but the admin's, every page load goes to the same page on
 * the admin's. Only page loads (GET, HEAD) move; server functions, the
 * MCP server, Discord's interactions and anything that changes something
 * are answered where they're asked.
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
  if (
    url.hostname === adminHost ||
    notPages.some((base) => isUnder(url.pathname, base))
  ) {
    return null;
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: `https://${adminHost}${url.pathname}${url.search}`,
      "cache-control": "no-store",
    },
  });
};
