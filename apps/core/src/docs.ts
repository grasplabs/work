import { z } from "zod";

import { signInConfig } from "./auth/config.ts";
import { docsPath, docsPolicy } from "./security-headers.ts";
import type { InlineHashes } from "./security-headers.ts";

// The SDK docs (apps/docs): a static site each release carries among the
// frontend's static files, under /docs (core's build writes it there), so
// every deployment serves the docs of the release it runs, to people and
// to the agent (llms.txt, and each page's Markdown at its `.md` address).
// No sign-in, as for the frontend's own files: they are the release's,
// the same in every deployment, and hold nothing of the organization's.
//
// Its pages run inline scripts and styles of the docs framework's, which
// the frontend's policy refuses. They get a policy that allows exactly
// those, by the hashes the docs' build read from every page it built
// (apps/docs/build.ts): a script or style injected later runs nowhere.

/** The hashes the docs' build wrote (apps/docs/build.ts). */
const inlineHashesPath = `${docsPath}/inline-hashes.json`;

const sources = z.array(z.string().regex(/^'sha256-[\w+/]+=*'$/u));
const inlineHashesSchema = z.object({
  scripts: sources,
  styles: sources,
  styleAttributes: sources,
});

/** None: a release without the docs' hashes runs none of their code. */
const noInlineCode: InlineHashes = {
  scripts: [],
  styles: [],
  styleAttributes: [],
};

/** The release's hashes, once read: they change only with it. */
let releaseHashes: InlineHashes | undefined;

const readInlineHashes = async (
  request: Request,
  env: Env
): Promise<InlineHashes> => {
  if (releaseHashes !== undefined) {
    return releaseHashes;
  }
  const file = await env.ASSETS.fetch(new URL(inlineHashesPath, request.url));
  // Without the file, the static files answer the frontend's page.
  const isJson =
    file.headers.get("content-type")?.includes("application/json") ?? false;
  if (!(file.ok && isJson)) {
    await file.body?.cancel();
    return noInlineCode;
  }
  const parsed = inlineHashesSchema.safeParse(await file.json());
  if (!parsed.success) {
    return noInlineCode;
  }
  releaseHashes = parsed.data;
  return releaseHashes;
};

const isHtml = (response: Response): boolean =>
  response.headers.get("content-type")?.includes("text/html") ?? false;

/**
 * Whether the static files answered with the frontend's page, which they
 * give any path that names no file (`not_found_handling`): the same file
 * as the frontend's root, by its tag.
 */
const isFrontendPage = async (
  page: Response,
  request: Request,
  env: Env
): Promise<boolean> => {
  const etag = page.headers.get("etag");
  if (etag === null || !isHtml(page)) {
    return false;
  }
  const frontend = await env.ASSETS.fetch(new URL("/", request.url), {
    method: "HEAD",
  });
  return frontend.headers.get("etag") === etag;
};

/** The docs' page for a path they don't have. */
const notFoundPath = `${docsPath}/404.html`;

/**
 * The request for the file at `request`'s address. The docs link each
 * page by its folder without a trailing `/` (`/docs/guides/pages`), whose
 * file is the folder's `index.html`: asked for by the folder itself, so
 * the static files answer with it rather than redirect to it.
 */
const fileRequest = (request: Request): Request => {
  const url = new URL(request.url);
  const name = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  if (name === "" || name.includes(".")) {
    return request;
  }
  url.pathname = `${url.pathname}/`;
  return new Request(url, request);
};

/**
 * The docs' file at `request`'s path, or their own not-found page, 404,
 * for a path they don't have; a redirect or a 304 as the static files
 * answer. Every answer carries the docs' policy: a browser keeps the
 * policy of a 304 for the page it revalidated.
 */
export const docsResponse = async (
  request: Request,
  env: Env
): Promise<Response> => {
  let page = await env.ASSETS.fetch(fileRequest(request));
  let { status } = page;
  if (await isFrontendPage(page, request, env)) {
    await page.body?.cancel();
    page = await env.ASSETS.fetch(new URL(notFoundPath, request.url));
    status = 404;
  }
  const headers = new Headers(page.headers);
  headers.set(
    "content-security-policy",
    docsPolicy(
      signInConfig(env)?.origin ?? new URL(request.url).origin,
      await readInlineHashes(request, env)
    )
  );
  if (isHtml(page)) {
    // A release replaces every page: checked again on each load.
    headers.set("cache-control", "no-cache");
  }
  return new Response(page.body, { status, headers });
};
