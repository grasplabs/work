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

const readInlineHashes = async (
  request: Request,
  env: Env
): Promise<InlineHashes> => {
  const file = await env.ASSETS.fetch(new URL(inlineHashesPath, request.url));
  // Without the file, the static files answer the frontend's page.
  const isJson =
    file.headers.get("content-type")?.includes("application/json") ?? false;
  if (!(file.ok && isJson)) {
    await file.body?.cancel();
    return noInlineCode;
  }
  const parsed = inlineHashesSchema.safeParse(await file.json());
  return parsed.success ? parsed.data : noInlineCode;
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
 * The docs' file at `request`'s path: a page under the docs' policy, and
 * the docs' own not-found page, 404, for a path they don't have.
 */
export const docsResponse = async (
  request: Request,
  env: Env
): Promise<Response> => {
  let page = await env.ASSETS.fetch(request);
  let { status } = page;
  if (await isFrontendPage(page, request, env)) {
    await page.body?.cancel();
    page = await env.ASSETS.fetch(new URL(notFoundPath, request.url));
    status = 404;
  }
  if (!(page.ok && isHtml(page))) {
    return page;
  }
  const headers = new Headers(page.headers);
  headers.set(
    "content-security-policy",
    docsPolicy(
      signInConfig(env)?.origin ?? new URL(request.url).origin,
      await readInlineHashes(request, env)
    )
  );
  // A release replaces every page: checked again on each load.
  headers.set("cache-control", "no-cache");
  return new Response(page.body, { status, headers });
};
