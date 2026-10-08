import { compilerVersion } from "@grasp-os/compiler";
import { isExpectedError } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import { log } from "@grasp-os/shared/log";
import {
  isPackageArtifactPath,
  packageArtifactPath,
} from "@grasp-os/shared/packages";
import { drizzle } from "drizzle-orm/d1";

import { policyGeneration } from "../dependencies/policy.ts";
import { admitDependencies } from "../dependencies/requests.ts";
import { accessTokenPattern, hasFrameAccess } from "../screen-frame.ts";
import { artifactSubject } from "./address.ts";
import type { ArtifactRef } from "./address.ts";
import { keptDescription, keptFile, lockOf } from "./build.ts";

// Serving an App's built packages to the browser: the one route that
// hands out an artifact's files. Every response on its path, an error
// included, gets the artifact policy with core's other headers
// (`packageArtifactPolicy`, security-headers.ts), and this route sets
// nothing of it, so no answer here can go out without it.
//
// The build refuses only what it can decide whole (build.ts). What a
// file's code does once it runs (a worker made from a computed name,
// `importScripts`, a fetch, CSS set from script) is the browser's to stop,
// under that policy wherever a file is opened on its own, and under the
// screen frame's where a screen runs it. What could go wrong here, and
// what stops it:
//
// - Serving what is no longer approved, or other bytes than were built.
//   Each request asks `admitDependencies` again, for this App, graph and
//   the browser target under the policy generation now (it audits a
//   refusal); the App's lock must still pin this artifact as this
//   compiler's browser build; the artifact's description must hash to its
//   address; and the file's bytes to the SHA-256 the description names.
//   Answers are never cached, so an approval taken back holds from the
//   next load.
// - A file taken for another type. Each is sent with the exact type the
//   build recorded for it, one of the few the builder writes, and
//   `nosniff`: script is never read as a stylesheet, an image never as a
//   page. A recorded type outside those isn't served.
// - Reading an artifact by its hashes alone (from an audit entry, say).
//   Each address carries a token core made for exactly that App, graph and
//   artifact, which expires (address.ts). It is a path segment, not a
//   query, so a file's relative imports and `url()`s keep it; the request
//   log leaves it out (`withoutArtifactToken`).
// - Code for Workers sent to a browser. Only the browser target is
//   served; server, workflow and computation artifacts never leave core.

const artifactPattern = new RegExp(
  `^${packageArtifactPath}/(?<app>[\\w-]{1,128})/(?<graphHash>[0-9a-f]{64})/(?<hash>[0-9a-f]{64})/(?<token>[^/]{1,96})/(?<file>.{1,1024})$`,
  "u"
);

/** The token's segment of an artifact path, for the request log. */
const tokenSegment = new RegExp(
  `^(?<base>${packageArtifactPath}(?:/[^/]*){3}/)[^/]+(?<rest>/.*)?$`,
  "u"
);

/** `pathname` as the request log keeps it: an artifact's token left out. */
export const withoutArtifactToken = (pathname: string): string => {
  const groups = tokenSegment.exec(pathname)?.groups;
  return groups?.base === undefined
    ? pathname
    : `${groups.base}-${groups.rest ?? ""}`;
};

/**
 * The exact type each kind of file an artifact holds is served with: the
 * types the builder records (@grasp-os/compiler, packages/build.ts). A file
 * recorded with any other isn't served.
 */
const servedTypes: ReadonlyMap<string, string> = new Map([
  ["text/javascript", "text/javascript; charset=utf-8"],
  ["text/css", "text/css; charset=utf-8"],
  ["image/png", "image/png"],
  ["image/jpeg", "image/jpeg"],
  ["image/gif", "image/gif"],
  ["image/webp", "image/webp"],
  ["image/avif", "image/avif"],
  ["image/x-icon", "image/x-icon"],
  ["image/svg+xml", "image/svg+xml"],
  ["font/woff", "font/woff"],
  ["font/woff2", "font/woff2"],
  ["font/ttf", "font/ttf"],
  ["font/otf", "font/otf"],
]);

/** An answer that serves nothing. */
const refused = (status: 403 | 404 | 405): Response =>
  new Response(status === 404 ? "Not found" : "Not allowed", {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...(status === 405 ? { allow: "GET, HEAD" } : {}),
    },
  });

/** Whether the App's graph is approved for the browser, now. */
const admitted = async (env: Env, ref: ArtifactRef): Promise<boolean> => {
  try {
    await admitDependencies(
      env,
      { type: "app", appId: ref.app, part: "screen" },
      {
        app: ref.app,
        graphHash: ref.graphHash,
        targets: ["browser"],
        policyGeneration: await policyGeneration(drizzle(env.DB)),
      }
    );
    return true;
  } catch (error) {
    if (isExpectedError(error)) {
      return false;
    }
    throw error;
  }
};

/** Whether the App's lock still pins `ref` as this compiler's browser build. */
const pinned = async (env: Env, ref: ArtifactRef): Promise<boolean> => {
  try {
    const { lock } = await lockOf(env, ref.app, ref.graphHash);
    return lock.artifacts?.[compilerVersion]?.browser?.hash === ref.hash;
  } catch (error) {
    if (isExpectedError(error)) {
      return false;
    }
    throw error;
  }
};

const decoded = (path: string): string | undefined => {
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
};

/** What an artifact path names: the artifact, its token and one file. */
interface Addressed {
  ref: ArtifactRef;
  token: string;
  file: string;
}

const addressed = (pathname: string): Addressed | undefined => {
  const groups = artifactPattern.exec(pathname)?.groups;
  const app = appIdSchema.safeParse(groups?.app);
  const file = decoded(groups?.file ?? "");
  if (
    !app.success ||
    groups?.graphHash === undefined ||
    groups.hash === undefined ||
    groups.token === undefined ||
    file === undefined
  ) {
    return undefined;
  }
  return {
    ref: { app: app.data, graphHash: groups.graphHash, hash: groups.hash },
    token: groups.token,
    file,
  };
};

/** File `file` of the kept browser artifact `hash`, as built, or a refusal. */
const keptResponse = async (
  env: Env,
  hash: string,
  file: string
): Promise<Response> => {
  const description = await keptDescription(env, hash);
  const entry =
    description !== undefined && Object.hasOwn(description.files, file)
      ? description.files[file]
      : undefined;
  if (description?.target !== "browser" || entry === undefined) {
    return refused(404);
  }
  const type = servedTypes.get(entry.type);
  if (type === undefined) {
    log.warn("packages.artifact_type_refused", {
      hash,
      path: file,
      type: entry.type,
    });
    return refused(404);
  }
  const bytes = await keptFile(env, hash, file, entry.sha256);
  if (bytes === undefined) {
    return refused(404);
  }
  return new Response(bytes, {
    headers: {
      "content-type": type,
      // Every load asks again, so an approval taken back holds at once.
      "cache-control": "no-store",
    },
  });
};

/**
 * A file of an App's built packages, or null when the path isn't on the
 * artifact path. Only with a token core made for that artifact, while its
 * graph is approved, its lock pins it, and its bytes are the ones built.
 */
export const packageArtifactResponse = async (
  env: Env,
  request: Request
): Promise<Response | null> => {
  const { pathname } = new URL(request.url);
  if (!isPackageArtifactPath(pathname)) {
    return null;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return refused(405);
  }
  const asked = addressed(pathname);
  if (asked === undefined) {
    return refused(404);
  }
  const { ref, token } = asked;
  if (
    !accessTokenPattern.test(token) ||
    !(await hasFrameAccess(env, artifactSubject(ref), token))
  ) {
    return refused(403);
  }
  if (!(await admitted(env, ref))) {
    return refused(403);
  }
  if (!(await pinned(env, ref))) {
    return refused(404);
  }
  return await keptResponse(env, ref.hash, asked.file);
};
