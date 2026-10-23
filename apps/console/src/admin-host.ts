/**
 * Grasp's admin on a hostname of its own (`admin.<domain>`), served by the
 * console's Worker like every other page. The admin is the one place staff
 * manage everything, so every page load moves there: the console's
 * hostname only still answers what isn't a page (server functions, the
 * admin's MCP server, Discord's interactions) and what changes something.
 * Both hostnames sit behind the same Access application, so the Access
 * check (src/access.ts) is the same on either.
 *
 * The console's own pages, gone into the admin, move to where they went:
 * its front page to the admin's, a client's page to its organization's
 * Setup, the new-client form to adding an organization, whatever the
 * address asked besides kept. The router does the same where there is no
 * admin hostname (src/routes/index.tsx, src/routes/clients/).
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

/** The console's new-client form, now adding an organization. */
const newClientPath = "/clients/new";

/** A client's page in the console: `/clients/<id>`, one segment. */
const clientPage = /^\/clients\/(?<clientId>[^/]+)\/?$/u;

/**
 * Where an old console page went in the admin, or null for any other
 * path, which stays as it is.
 */
export const adminPathOf = (pathname: string): string | null => {
  if (pathname === "/") {
    return "/admin";
  }
  if (pathname === newClientPath || pathname === `${newClientPath}/`) {
    return "/admin/new-organization";
  }
  const clientId = clientPage.exec(pathname)?.groups?.clientId;
  return clientId === undefined
    ? null
    : `/admin/organizations/${clientId}/setup`;
};

/** A move to another hostname, never kept by a browser or cache: `ADMIN_HOST` may change. */
const redirectTo = (location: string): Response =>
  new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store" },
  });

/** An old console page's move within the admin's hostname: for good. */
const movedFor = (location: string): Response =>
  new Response(null, { status: 301, headers: { location } });

/**
 * Where a page request should go instead, or null to serve it here:
 * - on the admin's hostname, an old console page goes to where it went in
 *   the admin, and everything else is served;
 * - on any other hostname, every page goes to the admin's hostname, an
 *   old console page straight to where it went.
 * Only page loads (GET, HEAD) move; server functions, the MCP server,
 * Discord's interactions and anything that changes something are
 * answered where they're asked.
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
  if (notPages.some((base) => isUnder(url.pathname, base))) {
    return null;
  }
  const moved = adminPathOf(url.pathname);
  if (url.hostname === adminHost) {
    return moved === null ? null : movedFor(`${moved}${url.search}`);
  }
  return redirectTo(
    `https://${adminHost}${moved ?? url.pathname}${url.search}`
  );
};
