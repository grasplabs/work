import { isExpectedError } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import { log } from "@grasp-os/shared/log";
import {
  isPackageArtifactPath,
  packageArtifactPath,
} from "@grasp-os/shared/packages";
import { drizzle } from "drizzle-orm/d1";
import { ZodError } from "zod";

import { policyGeneration } from "../dependencies/policy.ts";
import { admissionOf } from "../dependencies/requests.ts";
import { accessTokenPattern, hasFrameAccess } from "../screen-frame.ts";
import { artifactSubject } from "./address.ts";
import type { ArtifactRef } from "./address.ts";
import { forgetArtifact, keptDescription, keptFile, lockOf } from "./build.ts";

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
//   Each request makes the admission check again (`admissionOf`, the one
//   `admitDependencies` makes), for this App, graph and the browser target
//   under the policy generation now; a refusal is logged, not audited, so
//   a page asking for many files can't flood the audit trail. The App's
//   lock must still pin this artifact as a browser build, of one of the
//   compilers whose pins it keeps (two releases may serve side by side);
//   the artifact's description must hash to its address; and the file's
//   bytes to the SHA-256 the description names. A file whose bytes don't
//   match isn't served, and its artifact is made again by the next build.
//   Answers are never cached, so a change of policy holds from the next
//   load, and so will an approval taken back once that exists (GRA-359).
// - A file taken for another type. Each is sent with the exact type the
//   build recorded for it, one of the few the builder writes, and
//   `nosniff`: script is never read as a stylesheet, an image never as a
//   page. A recorded type outside those isn't served.
// - Reading an artifact by its hashes alone (from an audit entry, say).
//   Each address carries a token core made for exactly that App, graph and
//   artifact, which expires (address.ts). It is a path segment, not a
//   query, so a file's relative imports and `url()`s keep it. The cost:
//   core's own request log leaves it out (`withoutArtifactToken`), and
//   every answer says `Referrer-Policy: no-referrer` so it never travels
//   as a Referer, but Cloudflare's traces of core and the router redact
//   only query strings, so they keep the whole path, token included. We
//   accept that: a token holds for at most about 12 hours, it opens only
//   bytes built from public npm code, and admission and the lock are
//   checked again on every request, so it never serves anything no longer
//   approved.
// - Code for Workers sent to a browser. Only the browser target is
//   served: a pin of the lock's for the browser target is the guard, as an
//   artifact's hash covers its target, so no other target's artifact is
//   ever pinned as the browser's.

const artifactPattern = new RegExp(
  `^${packageArtifactPath}/(?<app>[\\w-]{1,128})/(?<graphHash>[0-9a-f]{64})/(?<hash>[0-9a-f]{64})/(?<token>[^/]{1,96})/(?<file>.{1,1024})$`,
  "u"
);

/**
 * An artifact path up to its token, the token, and what follows: the
 * segments `artifactPattern` reads, exactly, so the segment left out is
 * the one it takes as the token.
 */
const tokenSegment = new RegExp(
  `^(?<base>${packageArtifactPath}/[\\w-]{1,128}/[0-9a-f]{64}/[0-9a-f]{64}/)[^/]{1,96}(?<rest>/.*)?$`,
  "u"
);

/**
 * `pathname` as the request log keeps it: an artifact's token left out.
 * A path on the artifact path that isn't shaped as an address (an empty
 * segment, one too many) is logged without anything after the artifact
 * path, since a token could be in any of its segments.
 */
export const withoutArtifactToken = (pathname: string): string => {
  if (!isPackageArtifactPath(pathname)) {
    return pathname;
  }
  const groups = tokenSegment.exec(pathname)?.groups;
  return groups?.base === undefined
    ? `${packageArtifactPath}/-`
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

/**
 * Whether the App's graph is approved for the browser, now. A refusal is
 * logged, not audited: a page asks for many files, and each refused one
 * would otherwise be a row in the audit trail.
 */
const admitted = async (env: Env, ref: ArtifactRef): Promise<boolean> => {
  const db = drizzle(env.DB);
  const admission = await admissionOf(db, {
    app: ref.app,
    graphHash: ref.graphHash,
    targets: ["browser"],
    policyGeneration: await policyGeneration(db),
  });
  if (!admission.admitted) {
    log.warn("packages.serve_refused", {
      app: ref.app,
      graphHash: ref.graphHash,
      hash: ref.hash,
      reason: admission.reason,
    });
  }
  return admission.admitted;
};

/**
 * Whether the App's lock still pins `ref` as a browser build: of any of
 * its target configs, by any compiler whose pins it keeps (two releases
 * may serve side by side, each the builds it pinned).
 */
const pinned = async (env: Env, ref: ArtifactRef): Promise<boolean> => {
  try {
    const { lock } = await lockOf(env, ref.app, ref.graphHash);
    return Object.values(lock.artifacts ?? {}).some((pins) =>
      Object.values(pins).some(
        ({ target, hash }) => target === "browser" && hash === ref.hash
      )
    );
  } catch (error) {
    if (isExpectedError(error)) {
      return false;
    }
    // A lock that doesn't read as this release's (one an older release
    // wrote as this one deploys): nothing it pins is served.
    if (error instanceof ZodError) {
      log.warn("packages.lock_unreadable", {
        app: ref.app,
        graphHash: ref.graphHash,
      });
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

/**
 * File `file` of the kept artifact `hash`, as built, or a refusal. The
 * caller has checked the lock pins it as the browser's build.
 */
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
  if (entry === undefined) {
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
    // Not the bytes built: never served, and made again by the next build.
    await forgetArtifact(env, hash);
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
