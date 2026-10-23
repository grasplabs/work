/**
 * The console's pages that moved into Grasp's admin, so Grasp has one
 * place to manage everything. An old address, bookmarked or in a message,
 * moves to the new one for good, its query kept:
 * - its Releases and Rollouts pages are under the admin's Platform
 *   (`/admin/platform/releases`, `/admin/platform/rollouts`), the path
 *   below them kept;
 * - its front page, the list of clients, is the admin's overview;
 * - its new-client form is adding an organization;
 * - a client's page is its organization's Setup.
 * Where the admin has a hostname of its own, the admin's redirect
 * (src/admin-host.ts) takes it on from there.
 */

/** A path under one of the moved Platform pages, and the rest of it. */
const platformPage = /^\/(?<page>releases|rollouts)(?<rest>\/.*)?$/u;

const platformPath = "/admin/platform";

/** A client's page in the console: `/clients/<id>`, one segment. */
const clientPage = /^\/clients\/(?<clientId>[^/]+)\/?$/u;

const newClientPaths: ReadonlySet<string> = new Set([
  "/clients/new",
  "/clients/new/",
]);

/** Where an old console page went in the admin; null for any other path. */
export const movedPathOf = (pathname: string): string | null => {
  if (pathname === "/") {
    return "/admin";
  }
  if (newClientPaths.has(pathname)) {
    return "/admin/new-organization";
  }
  const platform = platformPage.exec(pathname)?.groups;
  if (platform !== undefined) {
    const { page = "", rest = "" } = platform;
    return `${platformPath}/${page}${rest}`;
  }
  const clientId = clientPage.exec(pathname)?.groups?.clientId;
  return clientId === undefined
    ? null
    : `/admin/organizations/${clientId}/setup`;
};

/**
 * Where a page request for a moved page goes instead, or null when it
 * isn't one. Only page loads (GET, HEAD) move: nothing else was ever
 * asked of those pages.
 */
export const movedPageRedirect = (request: Request): Response | null => {
  if (!["GET", "HEAD"].includes(request.method)) {
    return null;
  }
  const url = new URL(request.url);
  const moved = movedPathOf(url.pathname);
  return moved === null
    ? null
    : new Response(null, {
        status: 301,
        headers: { location: `${moved}${url.search}` },
      });
};
