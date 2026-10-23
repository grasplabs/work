/**
 * The console's pages that moved into Grasp's admin, so Grasp has one
 * place to manage everything: its Releases and Rollouts pages are under
 * the admin's Platform now (`/admin/platform/releases`,
 * `/admin/platform/rollouts`). An old address, bookmarked or in a
 * message, moves to the new one for good, its path below and its query
 * kept. Where the admin has a hostname of its own, the admin's redirect
 * (src/admin-host.ts) takes it on from there.
 */

/** A path under one of the moved pages, and the rest of it. */
const movedPath = /^\/(?<page>releases|rollouts)(?<rest>\/.*)?$/u;

const platformPath = "/admin/platform";

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
  const match = movedPath.exec(url.pathname);
  if (match?.groups === undefined) {
    return null;
  }
  const { page = "", rest = "" } = match.groups;
  return new Response(null, {
    status: 301,
    headers: { location: `${platformPath}/${page}${rest}${url.search}` },
  });
};
