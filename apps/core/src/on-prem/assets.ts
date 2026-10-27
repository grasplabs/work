/**
 * The on-prem profile's static assets: core's `ASSETS` on plain workerd,
 * which has no assets binding.
 *
 * Core never sees this module. On Cloudflare `ASSETS` is Workers static
 * assets, over the folder wrangler.jsonc names (`../web/dist`): the
 * frontend, and the compiler, SDK, kit and extractor files a seal, a build
 * and a workflow run read. On-prem, the workerd config binds `ASSETS` to
 * this Worker, and this Worker's `FILES` to a workerd disk service over the
 * same folder (scripts/workerd-assets.ts writes that config). The disk
 * service answers a file's bytes alone, typed `application/octet-stream`,
 * and a folder as a JSON listing of it; this Worker answers as Workers'
 * assets do where core relies on it:
 *
 * - each file with the type its extension says, which core checks before
 *   it runs what it read (packages/compiler/src/index.ts,
 *   src/brain/extract.ts);
 * - a path that names no file with the frontend's `index.html`
 *   (`not_found_handling: "single-page-application"`), which src/entry.ts
 *   relies on for the frontend's own routes, and which core's readers take
 *   for a missing file by its type;
 * - a folder never as its listing: `/dir/` is its `index.html`, as
 *   Workers' `html_handling` reads it, and a folder is no file otherwise;
 * - the caching headers Workers' assets send: an `ETag` and
 *   `Cache-Control: public, max-age=0, must-revalidate`, and 304 for a
 *   request whose `If-None-Match` has the file's tag;
 * - GET and HEAD only.
 *
 * Not here: Workers' redirects of `/x.html` and `/x/index.html` to their
 * pretty paths, and `_headers` and `_redirects` files. The frontend has
 * none of them, and core asks for none.
 */

/** What the workerd config gives this Worker. */
interface AssetsEnv {
  /** A workerd disk service over the assets' folder, read-only. */
  FILES: Fetcher;
}

/** The type of each kind of file the assets have, by extension. */
const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

/** What Workers' assets send, so a browser checks its copy every time. */
const cacheControl = "public, max-age=0, must-revalidate";

/** The page every path that names no file answers with. */
const fallbackPage = "/index.html";

/** The disk service's type for a file; a folder's listing is JSON. */
const fileType = "application/octet-stream";

/** The type a file's name says. */
const contentTypeOf = (pathname: string): string => {
  const name = pathname.slice(pathname.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return (
    (dot === -1 ? undefined : contentTypes[name.slice(dot).toLowerCase()]) ??
    "application/octet-stream"
  );
};

/** One file the disk service answered, and where it was found. */
interface Found {
  pathname: string;
  response: Response;
}

/**
 * The file at `pathname` from the disk service, or nothing: a path that
 * names no file, or names a folder.
 */
const fileAt = async (
  files: Fetcher,
  pathname: string,
  method: string
): Promise<Found | undefined> => {
  const response = await files.fetch(new URL(pathname, "http://files"), {
    method,
  });
  if (
    response.ok &&
    (response.headers.get("content-type") ?? "") === fileType
  ) {
    return { pathname, response };
  }
  await response.body?.cancel();
  return undefined;
};

/**
 * The paths a request's path may name, in the order Workers' assets try
 * them: the file itself, else its `.html` or its folder's `index.html`.
 */
const candidates = (pathname: string): string[] =>
  pathname.endsWith("/")
    ? [`${pathname}index.html`]
    : [pathname, `${pathname}.html`, `${pathname}/index.html`];

/** The first of `paths` that is a file. */
const firstFile = async (
  files: Fetcher,
  paths: readonly string[],
  method: string
): Promise<Found | undefined> => {
  const [first, ...rest] = paths;
  if (first === undefined) {
    return undefined;
  }
  return (
    (await fileAt(files, first, method)) ??
    (await firstFile(files, rest, method))
  );
};

const hex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

/**
 * A file's tag: from its path, size and when it last changed, so it
 * changes whenever an install replaces the file, and reading it needs no
 * pass over its bytes.
 */
const etagOf = async ({ pathname, response }: Found): Promise<string> => {
  const stamp = [
    pathname,
    response.headers.get("content-length") ?? "",
    response.headers.get("last-modified") ?? "",
  ].join("\n");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stamp)
  );
  return `"${hex(digest).slice(0, 32)}"`;
};

/** Whether `If-None-Match` names `etag`, weakly as HTTP compares it. */
const notModified = (ifNoneMatch: string | null, etag: string): boolean =>
  ifNoneMatch !== null &&
  ifNoneMatch
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//u, ""))
    .some((tag) => tag === "*" || tag === etag);

/** What the assets answer `request` with. */
const assetResponse = async (
  request: Request,
  env: AssetsEnv
): Promise<Response> => {
  const { method } = request;
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }
  const { pathname } = new URL(request.url);
  const found =
    (await firstFile(env.FILES, candidates(pathname), method)) ??
    (await fileAt(env.FILES, fallbackPage, method));
  if (found === undefined) {
    return new Response("Not Found", { status: 404 });
  }
  const etag = await etagOf(found);
  const headers = new Headers({
    "cache-control": cacheControl,
    "content-type": contentTypeOf(found.pathname),
    etag,
  });
  if (notModified(request.headers.get("if-none-match"), etag)) {
    await found.response.body?.cancel();
    return new Response(null, { status: 304, headers });
  }
  const length = found.response.headers.get("content-length");
  if (length !== null) {
    headers.set("content-length", length);
  }
  return new Response(method === "HEAD" ? null : found.response.body, {
    status: 200,
    headers,
  });
};

export default {
  fetch: assetResponse,
} satisfies ExportedHandler<AssetsEnv>;
