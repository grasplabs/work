import {
  fromBase64Url,
  sha256Hex,
  toBase64Url,
} from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { artifactSchema } from "@grasp-os/shared/screen-trust";
import {
  screenFrameMessage,
  screenFrameReady,
  screenModulePath,
} from "@grasp-os/shared/screens";
import { z } from "zod";

import { signInConfig } from "./auth/config.ts";
import { derivedHmacKey } from "./derived-keys.ts";
import { screenFramePolicy } from "./security-headers.ts";

// The document an App's screen runs in, and the only code it can run.
//
// The frontend frames `/screen-frame?load=…&artifact=…` with
// `sandbox="allow-scripts"`, once core has handed it that build
// (screens-rpc.ts). It is served from its own address, with a policy of
// its own, because a `srcdoc` or `data:` frame inherits the policy of the
// page around it; only a document loaded over the network gets its own.
//
// That policy names, by hash or by exact address, every script the build
// may run, and nothing else: this document's own two inline scripts (the
// import map and the bootstrap below) and each module of the build at
// `/screen-modules/<hash>.js`, where core serves exactly those bytes. No
// `'unsafe-inline'`, no `data:` or `blob:`, no eval. So code that comes
// from anywhere but the build doesn't run, even when the build's own code
// lets it in: HTML an App's server sends that the screen renders (an
// `onerror` attribute, a `<script>`), a module the screen imports from a
// string (`import("data:…")`), `eval` or `new Function`, a second import
// map. What an admin approved, a build's hash, is then what the frame
// runs; a change to the App's server changes data, never code. Browsers
// match a policy's addresses on scheme, host, port and the exact path,
// so the policy names the deployment's own origin as people reach it
// (`SIGN_IN.origin`, behind the router), not the address core is called
// at.
//
// It starts in two stages (@grasp-os/shared/screens): the bootstrap says
// it listens, with the `load` its address carries; the runtime says the
// screen has mounted. The page waits ten seconds for each and stops the
// frame otherwise (screen-host.ts). Only the first message from the page
// that names this load and this build counts, so nothing can restart it
// later; the page in turn talks to the first frame document only.

/** What a frame runs of one screen, as core built it. */
export interface FrameCode {
  /** The module to render: its default export is the screen. */
  entry: string;
  /** The kit module that renders it (@grasp-os/sdk/screen-runtime). */
  runtime: string;
  /** The App's modules, by flat name. */
  modules: Record<string, string>;
  /** The kit's modules the App's need, by flat name. */
  kit: Record<string, string>;
  css: string;
}

// Who may load a build's frame and modules. A sandboxed frame sends no
// cookies, so its document and modules can't ask for a session; instead
// each address carries a token core made for exactly that build or
// module, which expires: the page gets the frame's with the build
// (`ScreenBundle.frameToken`), the frame's document the modules'. A hash
// alone, from an audit entry say, reads nothing.

/** What the tokens' key is for: no other MAC of core's passes for one. */
const accessPurpose = "grasp-os screen frame access";

/** How long a frame's token holds: the page frames it at once. */
const frameAccessMs = 10 * 60 * 1000;

/**
 * Module tokens hold until the end of the next six-hour window, so every
 * frame in one window names a module at the same address, which the
 * browser caches, and a screen open for hours can still load one late.
 */
const moduleAccessWindowMs = 6 * 60 * 60 * 1000;

const encoder = new TextEncoder();

const accessMac = async (
  env: Env,
  subject: string,
  expires: number
): Promise<Uint8Array> => {
  const key = await derivedHmacKey(env, accessPurpose, ["sign", "verify"]);
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(canonicalJson([subject, expires]))
    )
  );
};

/** A token for `subject` that holds until `expires` (ms since the epoch). */
const accessToken = async (
  env: Env,
  subject: string,
  expires: number
): Promise<string> =>
  `${expires}.${toBase64Url(await accessMac(env, subject, expires))}`;

/** A token for the frame of `artifact`, for the page to frame it with. */
export const frameAccess = async (
  env: Env,
  artifact: string,
  now = Date.now()
): Promise<string> =>
  await accessToken(env, `frame:${artifact}`, now + frameAccessMs);

/** A token for the module `hash`, for a frame's import map. */
const moduleAccess = async (
  env: Env,
  hash: string,
  now: number
): Promise<string> =>
  await accessToken(
    env,
    `module:${hash}`,
    (Math.floor(now / moduleAccessWindowMs) + 2) * moduleAccessWindowMs
  );

const tokenPattern = /^(?<expires>\d{1,16})\.(?<mac>[\w-]{1,64})$/u;

/** Whether `token` is core's for `subject`, and hasn't expired. */
const hasFrameAccess = async (
  env: Env,
  subject: string,
  token: string | null
): Promise<boolean> => {
  const groups = tokenPattern.exec(token ?? "")?.groups;
  const expires = Number(groups?.expires);
  if (groups?.mac === undefined || !(expires > Date.now())) {
    return false;
  }
  let mac: Uint8Array<ArrayBuffer>;
  try {
    mac = fromBase64Url(groups.mac);
  } catch {
    return false;
  }
  const key = await derivedHmacKey(env, accessPurpose, ["sign", "verify"]);
  return await crypto.subtle.verify(
    "HMAC",
    key,
    mac,
    encoder.encode(canonicalJson([subject, expires]))
  );
};

/** What core keeps of a build for its frame: its modules by name, as the hashes they are served under. */
interface FrameManifest {
  entry: string;
  runtime: string;
  css: string;
  imports: Record<string, string>;
}

const day = 24 * 60 * 60 * 1000;

/**
 * How long a staged build is kept after it was last staged: the cron's
 * sweep deletes what is older (`sweepScreenFrames`).
 */
export const frameKeepMs = 30 * day;

/**
 * How old a staged build may be and still be opened as it is: past this,
 * opening it stages it again, modules and all, so a build in use is never
 * as old as the sweep's limit.
 */
const frameRefreshMs = frameKeepMs / 2;

const framesPrefix = "screen-frames/";
const modulesPrefix = "screen-modules/";

const frameKey = (artifact: string): string =>
  `${framesPrefix}${artifact}.json`;

const moduleKey = (hash: string): string => `${modulesPrefix}${hash}.js`;

/** `/screen-modules/<hash>.js`: one module of a build, as the frame imports it. */
const modulePath = new RegExp(
  `^${screenModulePath}/(?<hash>[0-9a-f]{64})\\.js$`,
  "u"
);

/** Whether every module `hashes` names is stored. */
const allStaged = async (env: Env, hashes: string[]): Promise<boolean> => {
  const found = await Promise.all(
    hashes.map(async (hash) => await env.FILES.head(moduleKey(hash)))
  );
  return found.every((head) => head !== null);
};

/**
 * Keeps a build where its frame loads it: each module under the hash of
 * its name and code (one name, one module: the same code under two names
 * stays two modules), and the build's manifest under its own hash. The
 * modules go first, so a manifest is never there without them. A manifest
 * staged within `frameRefreshMs`, with every module of it still there, is
 * all of it; anything else is staged again in full, so the sweep never
 * takes a module of a build in use for long: its modules are never older
 * than its manifest, and one the sweep took anyway (it can't delete only
 * if unchanged) is put back here, and noticed by the frame's document.
 * Two opens at once both write it, the same bytes.
 */
export const stageFrame = async (
  env: Env,
  artifact: string,
  { entry, runtime, modules, kit, css }: FrameCode,
  now = new Date()
): Promise<void> => {
  const named = await Promise.all(
    Object.entries({ ...kit, ...modules }).map(async ([name, code]) => ({
      name,
      code,
      hash: await sha256Hex(canonicalJson([name, code])),
    }))
  );
  const staged = await env.FILES.head(frameKey(artifact));
  if (
    staged !== null &&
    now.getTime() - staged.uploaded.getTime() < frameRefreshMs &&
    (await allStaged(
      env,
      named.map(({ hash }) => hash)
    ))
  ) {
    return;
  }
  await Promise.all(
    named.map(async ({ code, hash }) => {
      await env.FILES.put(moduleKey(hash), code);
    })
  );
  const manifest: FrameManifest = {
    entry,
    runtime,
    css,
    imports: Object.fromEntries(named.map(({ name, hash }) => [name, hash])),
  };
  await env.FILES.put(frameKey(artifact), JSON.stringify(manifest));
};

/** Where the sweep left off: which prefix, and R2's cursor in it. */
const sweepKey = "screen-frames-sweep.json";

/** The most objects one run of the sweep reads. */
const sweepBatch = 500;

const sweptPrefixes = [framesPrefix, modulesPrefix] as const;

const sweepStateSchema = z.object({
  prefix: z
    .int()
    .min(0)
    .max(sweptPrefixes.length - 1),
  cursor: z.string().optional(),
});

/**
 * Deletes those of `objects` (a listing) last staged more than
 * `frameKeepMs` before `now`, each read again just before: one staged
 * again since the listing is kept. R2 deletes take no condition, so one
 * staged again between that read and the delete is still lost; the frame's
 * document and the next open notice and stage it again (`stageFrame`).
 */
export const deleteExpired = async (
  env: Env,
  objects: readonly R2Object[],
  now: Date
): Promise<void> => {
  const isOld = (uploaded: Date): boolean =>
    now.getTime() - uploaded.getTime() > frameKeepMs;
  const listedOld = objects.filter(({ uploaded }) => isOld(uploaded));
  const stillOld = await Promise.all(
    listedOld.map(async ({ key }) => {
      const head = await env.FILES.head(key);
      return head !== null && isOld(head.uploaded) ? [key] : [];
    })
  );
  const keys = stillOld.flat();
  if (keys.length > 0) {
    await env.FILES.delete(keys);
  }
};

/**
 * Deletes staged builds' manifests and modules last staged more than
 * `frameKeepMs` before `now`, from the cron: in code, not a bucket rule,
 * so it runs wherever core does. One page of one prefix a run, at most
 * `sweepBatch` objects, from where the last run stopped; once a prefix is
 * done, the next run starts the other.
 */
export const sweepScreenFrames = async (env: Env, now: Date): Promise<void> => {
  const stored = await env.FILES.get(sweepKey);
  const parsed = sweepStateSchema.safeParse(
    stored === null ? undefined : await stored.json()
  );
  const state = parsed.success ? parsed.data : { prefix: 0 };
  const prefix = sweptPrefixes[state.prefix] ?? framesPrefix;
  const listed = await env.FILES.list({
    prefix,
    limit: sweepBatch,
    ...(state.cursor === undefined ? {} : { cursor: state.cursor }),
  });
  await deleteExpired(env, listed.objects, now);
  const next = listed.truncated
    ? { prefix: state.prefix, cursor: listed.cursor }
    : { prefix: (state.prefix + 1) % sweptPrefixes.length };
  await env.FILES.put(sweepKey, JSON.stringify(next));
};

/**
 * What core answers for a frame or module it won't serve. A miss is
 * cheap to ask again, but not every time: a minute, unless it is one the
 * next open repairs.
 */
const refused = (
  status: 403 | 404,
  scripts: string[] = [],
  cache = status === 404 ? "public, max-age=60" : "no-store"
): Response =>
  new Response(status === 404 ? "Not found" : "Not allowed", {
    status,
    headers: {
      "content-security-policy": screenFramePolicy(scripts),
      "cache-control": cache,
    },
  });

/**
 * A module of a build, as the frame imports it, or null when the path
 * isn't one: only with a token core made for that module that hasn't
 * expired (`frameAccess`).
 */
export const screenModuleResponse = async (
  env: Env,
  url: URL
): Promise<Response | null> => {
  const hash = modulePath.exec(url.pathname)?.groups?.hash;
  if (hash === undefined) {
    return null;
  }
  const token = url.searchParams.get("token");
  if (!(await hasFrameAccess(env, `module:${hash}`, token))) {
    return refused(403);
  }
  const module = await env.FILES.get(moduleKey(hash));
  if (module === null) {
    return refused(404);
  }
  return new Response(module.body, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      // The frame's origin is opaque, so its module requests are
      // cross-origin, without cookies: the token in the address is what
      // lets it in.
      "access-control-allow-origin": "*",
      // Its address is its content, for as long as its token holds.
      "cache-control": "private, max-age=3600, immutable",
    },
  });
};

const bootstrap = `"use strict";
const load = new URLSearchParams(location.search).get("load");
const screen = JSON.parse(document.getElementById("screen").textContent);
const start = (event) => {
  const { data, ports } = event;
  if (
    event.source !== parent ||
    data?.type !== "${screenFrameMessage}" ||
    data.load !== load ||
    data.artifact !== screen.artifact ||
    ports.length !== 1
  ) {
    return;
  }
  removeEventListener("message", start);
  const style = document.createElement("style");
  style.textContent = screen.css;
  document.head.append(style);
  import(screen.runtime).then((runtime) =>
    runtime.runScreen(ports[0], screen.entry, {
      load,
      artifact: screen.artifact,
      generation: data.generation,
    })
  );
};
addEventListener("message", start);
parent.postMessage({ type: "${screenFrameReady}", load }, "*");`;

/**
 * `value` as JSON to put between `<script>` tags: a `<` would let the
 * text end the element, so each is written as the escape JSON reads the
 * same.
 */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value).replaceAll("<", "\\u003c");

/** A CSP hash source for an inline script with exactly `text`. */
const hashSource = async (text: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  );
  return `'sha256-${btoa(String.fromCodePoint(...digest))}'`;
};

/**
 * The frame's document for the build its address names, under a policy
 * that runs that build's modules and nothing else; core sets its other
 * headers with everyone else's. Only with a token core made for that
 * build that hasn't expired (`frameAccess`); a build core never staged
 * (no manifest) gets a document that runs nothing. Each module's address
 * in the import map carries a token of its own; the policy names the
 * addresses without them, as browsers match a policy's paths without the
 * query.
 */
export const screenFrameResponse = async (
  env: Env,
  url: URL
): Promise<Response> => {
  const artifact = artifactSchema.safeParse(url.searchParams.get("artifact"));
  if (!artifact.success) {
    return refused(404);
  }
  const token = url.searchParams.get("token");
  if (!(await hasFrameAccess(env, `frame:${artifact.data}`, token))) {
    return refused(403);
  }
  const stored = await env.FILES.get(frameKey(artifact.data));
  if (stored === null) {
    return refused(404);
  }
  const manifest = await stored.json<FrameManifest>();
  if (!(await allStaged(env, Object.values(manifest.imports)))) {
    // A module the sweep took from under it: the manifest goes too, so
    // the page's next open stages the whole build again.
    await env.FILES.delete(frameKey(artifact.data));
    return refused(404, [], "no-store");
  }
  const origin = signInConfig(env)?.origin ?? url.origin;
  const now = Date.now();
  const addressOf = (hash: string): string =>
    `${origin}${screenModulePath}/${hash}.js`;
  const imports: Record<string, string> = Object.fromEntries(
    await Promise.all(
      Object.entries(manifest.imports).map(async ([name, hash]) => {
        const access = await moduleAccess(env, hash, now);
        const query = new URLSearchParams({ token: access }).toString();
        return [name, `${addressOf(hash)}?${query}`] as const;
      })
    )
  );
  const importMap = scriptJson({ imports });
  const screen = scriptJson({
    artifact: artifact.data,
    entry: manifest.entry,
    runtime: manifest.runtime,
    css: manifest.css,
  });
  const scripts = [
    await hashSource(bootstrap),
    await hashSource(importMap),
    ...new Set(Object.values(manifest.imports).map((hash) => addressOf(hash))),
  ];
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>Screen</title>
    <script type="importmap">${importMap}</script>
    <script type="application/json" id="screen">${screen}</script>
    <script>${bootstrap}</script>
  </head>
  <body></body>
</html>
`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": screenFramePolicy(scripts),
    },
  });
};
