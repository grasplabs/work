/**
 * Pages the admin used to serve elsewhere, so Grasp has one place to
 * manage everything at the root of the admin's hostname. An old address,
 * bookmarked or in a message, moves straight to the page it is now, for
 * good, its query kept:
 * - everything under `/admin` is the same page without the prefix
 *   (`/admin/platform` is `/platform`, `/admin` the overview at `/`);
 * - the old Releases and Rollouts pages are under Platform
 *   (`/platform/releases`, `/platform/rollouts`), the path below them kept;
 * - the old new-client form is adding an organization
 *   (`/new-organization`);
 * - a client's old page is its organization's Setup
 *   (`/organizations/<id>/setup`).
 * Where the admin has a hostname of its own, its redirect
 * (src/admin-host.ts) takes it on from there.
 */

/** A path under `/admin`, and the rest of it. */
const adminPrefixed = /^\/admin(?<rest>\/.*)?$/u;

/** A path under one of the moved Platform pages, and the rest of it. */
const platformPage = /^\/(?<page>releases|rollouts)(?<rest>\/.*)?$/u;

/** A client's old page: `/clients/<id>`, one segment. */
const clientPage = /^\/clients\/(?<clientId>[^/]+)\/?$/u;

const newClientPaths: ReadonlySet<string> = new Set([
  "/clients/new",
  "/clients/new/",
]);

/** Where an old page is now; null for any other path. */
export const movedPathOf = (pathname: string): string | null => {
  const prefixed = adminPrefixed.exec(pathname)?.groups;
  if (prefixed !== undefined) {
    return prefixed.rest ?? "/";
  }
  if (newClientPaths.has(pathname)) {
    return "/new-organization";
  }
  const platform = platformPage.exec(pathname)?.groups;
  if (platform !== undefined) {
    const { page = "", rest = "" } = platform;
    return `/platform/${page}${rest}`;
  }
  const clientId = clientPage.exec(pathname)?.groups?.clientId;
  return clientId === undefined ? null : `/organizations/${clientId}/setup`;
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
