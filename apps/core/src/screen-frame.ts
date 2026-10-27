import {
  fromBase64Url,
  sha256Hex,
  toBase64,
  toBase64Url,
} from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { log } from "@grasp-os/shared/log";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { artifactSchema } from "@grasp-os/shared/screen-trust";
import {
  screenErrors,
  screenFrameMessage,
  screenFrameReady,
  screenLanguageOf,
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

/**
 * When a token `windowedAccess` makes at `now` expires: the end of the
 * next window of `moduleAccessWindowMs`.
 */
export const windowedAccessEnd = (now: number): number =>
  (Math.floor(now / moduleAccessWindowMs) + 2) * moduleAccessWindowMs;

/**
 * A token for `subject` that holds until the end of the next window of
 * `moduleAccessWindowMs` (`windowedAccessEnd`): the same for everything
 * asked in one window. The subject says what it is for (`module:…`,
 * `package-artifact:…`), so one never passes for another.
 */
export const windowedAccess = async (
  env: Env,
  subject: string,
  now: number
): Promise<string> => await accessToken(env, subject, windowedAccessEnd(now));

/** A token for the module `hash`, for a frame's import map. */
const moduleAccess = async (
  env: Env,
  hash: string,
  now: number
): Promise<string> => await windowedAccess(env, `module:${hash}`, now);

/** What a token looks like: also the one path segment it may be. */
export const accessTokenPattern =
  /^(?<expires>\d{1,16})\.(?<mac>[\w-]{1,64})$/u;

/** Whether `token` is core's for `subject`, and hasn't expired. */
export const hasFrameAccess = async (
  env: Env,
  subject: string,
  token: string | null
): Promise<boolean> => {
  const groups = accessTokenPattern.exec(token ?? "")?.groups;
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

// What a frame runs is checked again each time core serves it, not only
// as core opened the build. In between, the build sits in R2
// (`stageFrame`), and the tokens say which build and which modules may be
// asked for, not what bytes R2 hands back: anyone who can write the
// bucket without core's secret could otherwise swap a module or a
// manifest, and the frame would run it with the App's data. So:
//
// - A module is served only when its bytes, with the name it was staged
//   under, hash to the address it is asked at, the one its token signs
//   (`screenModuleResponse`). The name is kept beside it, in the object's
//   metadata: a changed name passes no more than changed code does.
// - A manifest is served only with core's MAC over it and the build it
//   is for (`manifestMac`): it can't be written, edited, or moved to
//   another build without core's secret.
// - Either one that doesn't pass is refused, logged and deleted, so the
//   next open stages the build again from the sealed bytes.
//
// On top of that, the import map names each module's sha384 (`integrity`,
// Subresource Integrity), carried in the MAC'd manifest, so the browser
// checks the bytes it got too, whatever sits between core and it. Both,
// rather than SRI alone: a browser that doesn't read an import map's
// `integrity` ignores it, and SRI alone would let a tampered object sit
// in R2 until the build is staged again. The check on serve holds for
// every browser, so it is the one this relies on.

const moduleHashPattern = /^[0-9a-f]{64}$/u;

/** What core keeps of a build for its frame: its modules by name, as the hashes they are served under. */
const frameManifestSchema = z
  .strictObject({
    entry: z.string(),
    runtime: z.string(),
    css: z.string(),
    imports: z.record(z.string(), z.string().regex(moduleHashPattern)),
    /** Each module's Subresource Integrity, by its hash. */
    integrity: z.record(z.string(), z.string().startsWith("sha384-")),
  })
  .refine(({ imports, integrity }) =>
    Object.values(imports).every((hash) => Object.hasOwn(integrity, hash))
  );

type FrameManifest = z.infer<typeof frameManifestSchema>;

/** What the manifests' MAC key is for: no other MAC of core's passes for one. */
const manifestPurpose = "grasp-os screen frame manifest";

/** What a manifest's MAC covers: its text, as the manifest of `artifact`. */
const manifestSubject = (artifact: string, text: string): Uint8Array =>
  encoder.encode(canonicalJson([artifact, text]));

/** Core's MAC over `text` as the manifest of the build `artifact`. */
const manifestMac = async (
  env: Env,
  artifact: string,
  text: string
): Promise<string> => {
  const key = await derivedHmacKey(env, manifestPurpose, ["sign", "verify"]);
  return toBase64Url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, manifestSubject(artifact, text))
    )
  );
};

/** Whether `mac` is core's for `text` as the manifest of `artifact`. */
const isManifestOf = async (
  env: Env,
  artifact: string,
  text: string,
  mac: string | undefined
): Promise<boolean> => {
  if (mac === undefined) {
    return false;
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64Url(mac);
  } catch {
    return false;
  }
  const key = await derivedHmacKey(env, manifestPurpose, ["sign", "verify"]);
  return await crypto.subtle.verify(
    "HMAC",
    key,
    bytes,
    manifestSubject(artifact, text)
  );
};

// A module is staged, hashed, checked and served as the same UTF-8
// bytes, never as a string read back: reading text drops a leading BOM,
// and a lone surrogate doesn't survive encoding, so a hash of the string
// staged and one of the text read would differ, and the screen fail on
// every open. Its code is decoded only to hash, keeping a BOM.
const moduleDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

/**
 * The most bytes of one staged module, or of a build's manifest: no more
 * than everything one resource's builds may produce (`artifactBytes`).
 * Staging refuses a build with more, so serving reads nothing larger:
 * an object over it is refused by its size alone, before its body is
 * read, whoever wrote it.
 */
export const frameObjectMaxBytes = platformLimits.artifactBytes;

/** A build with a module or manifest over `frameObjectMaxBytes`. */
const oversizedBuild = (): Error =>
  screenErrors.create("screen.build_failed", {
    reason: "The screen's build has a module larger than one may be.",
  });

/** The hash a module is served under: of its name and its code. */
const codeHash = async (name: string, code: string): Promise<string> =>
  await sha256Hex(canonicalJson([name, code]));

/**
 * The hash of a module staged as `bytes`: of its name and its code as
 * they decode. Null for bytes that aren't UTF-8, which core never stages.
 */
const moduleHash = async (
  name: string,
  bytes: Uint8Array
): Promise<string | null> => {
  let code: string;
  try {
    code = moduleDecoder.decode(bytes);
  } catch {
    return null;
  }
  return await codeHash(name, code);
};

/** A module's Subresource Integrity: the sha384 of the bytes served. */
const moduleIntegrity = async (bytes: Uint8Array): Promise<string> =>
  `sha384-${toBase64(
    new Uint8Array(await crypto.subtle.digest("SHA-384", bytes))
  )}`;

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
 * stays two modules), with its name beside it, and the build's manifest
 * under its own hash, with core's MAC (checked on serve, as above). The
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
    Object.entries({ ...kit, ...modules }).map(async ([name, source]) => {
      // Encoding makes any lone surrogate U+FFFD: hashed as it decodes,
      // so as it is checked when served.
      const bytes = encoder.encode(source);
      const code = moduleDecoder.decode(bytes);
      return { name, bytes, hash: await codeHash(name, code) };
    })
  );
  if (named.some(({ bytes }) => bytes.byteLength > frameObjectMaxBytes)) {
    throw oversizedBuild();
  }
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
  const manifest: FrameManifest = {
    entry,
    runtime,
    css,
    imports: Object.fromEntries(named.map(({ name, hash }) => [name, hash])),
    integrity: Object.fromEntries(
      await Promise.all(
        named.map(
          async ({ bytes, hash }) =>
            [hash, await moduleIntegrity(bytes)] as const
        )
      )
    ),
  };
  const text = JSON.stringify(manifest);
  if (encoder.encode(text).byteLength > frameObjectMaxBytes) {
    throw oversizedBuild();
  }
  await Promise.all(
    named.map(async ({ name, bytes, hash }) => {
      await env.FILES.put(moduleKey(hash), bytes, { customMetadata: { name } });
    })
  );
  await env.FILES.put(frameKey(artifact), text, {
    customMetadata: { mac: await manifestMac(env, artifact, text) },
  });
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
 * expired (`frameAccess`), and only bytes that hash to its address.
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
  if (module.size > frameObjectMaxBytes) {
    // Larger than core stages: not read.
    await module.body.cancel();
    log.error("screen_frame.module_corrupt", { hash, bytes: module.size });
    await env.FILES.delete(moduleKey(hash));
    return refused(404, [], "no-store");
  }
  const bytes = new Uint8Array(await module.arrayBuffer());
  const name = module.customMetadata?.name;
  if (name === undefined || (await moduleHash(name, bytes)) !== hash) {
    // Not what core staged under this address: never served. Gone, so
    // the frame's document finds it missing and the next open stages the
    // build again; meanwhile a miss nothing caches.
    log.error("screen_frame.module_corrupt", { hash });
    await env.FILES.delete(moduleKey(hash));
    return refused(404, [], "no-store");
  }
  return new Response(bytes, {
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

// The bootstrap also tells the page each time the person acts in this
// frame (a click, a tap, a key), over a port of its own: the page counts a
// screen's navigation as the person's only on such an act
// (screen-host.ts), never on activation the frame may have focused itself
// into. The screen's code shares this realm, so what reports runs before
// any of it, and keeps what it needs where that code never reaches:
// - the port, and the intrinsics it reports and listens with, are taken
//   as this script starts, before any module loads, and held in its
//   closure only, never on a global or a prototype; patching
//   `MessagePort.prototype` or `EventTarget.prototype` later changes
//   nothing here;
// - its listeners are the window's first, in the capture phase, so no
//   listener of the screen's runs before them or stops them;
// - it reports only an event the browser made (`isTrusted`, each event's
//   own property that no script can redefine), never one a script
//   dispatched;
// - the report carries nothing: what counts is that it came over this
//   port, which only this script holds. The screen's ports and the page's
//   window are its own to post on, and the page reads no act from them.
const bootstrap = `"use strict";
const apply = Reflect.apply;
const listen = EventTarget.prototype.addEventListener;
const unlisten = EventTarget.prototype.removeEventListener;
const post = MessagePort.prototype.postMessage;
const load = new URLSearchParams(location.search).get("load");
const screen = JSON.parse(document.getElementById("screen").textContent);
const reportActs = (port) => {
  const acted = (event) => {
    if (event.isTrusted === true) {
      apply(post, port, [null]);
    }
  };
  for (const type of ["pointerdown", "pointerup", "mousedown", "keydown", "touchend"]) {
    apply(listen, window, [type, acted, true]);
  }
};
const start = (event) => {
  const { data, ports } = event;
  if (
    event.source !== parent ||
    data?.type !== "${screenFrameMessage}" ||
    data.load !== load ||
    data.artifact !== screen.artifact ||
    ports.length !== 4
  ) {
    return;
  }
  apply(unlisten, window, ["message", start]);
  reportActs(ports[3]);
  const style = document.createElement("style");
  style.textContent = screen.css;
  document.head.append(style);
  import(screen.runtime).then((runtime) =>
    runtime.runScreen(
      ports[0],
      screen.entry,
      { load, artifact: screen.artifact, generation: data.generation },
      ports[1],
      ports[2]
    )
  );
};
apply(listen, window, ["message", start]);
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
  // Larger than core stages: not read.
  const tooLarge = stored.size > frameObjectMaxBytes;
  if (tooLarge) {
    await stored.body.cancel();
  }
  const text = tooLarge ? "" : await stored.text();
  const parsed = frameManifestSchema.safeParse(
    !tooLarge &&
      (await isManifestOf(env, artifact.data, text, stored.customMetadata?.mac))
      ? JSON.parse(text)
      : undefined
  );
  if (!parsed.success) {
    // Not a manifest core staged for this build: it runs nothing, and
    // goes, so the page's next open stages the build again.
    log.error("screen_frame.manifest_corrupt", { artifact: artifact.data });
    await env.FILES.delete(frameKey(artifact.data));
    return refused(404, [], "no-store");
  }
  const manifest = parsed.data;
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
  const addressed = await Promise.all(
    Object.entries(manifest.imports).map(async ([name, hash]) => {
      const access = await moduleAccess(env, hash, now);
      const query = new URLSearchParams({ token: access }).toString();
      return { name, hash, address: `${addressOf(hash)}?${query}` };
    })
  );
  const imports: Record<string, string> = Object.fromEntries(
    addressed.map(({ name, address }) => [name, address])
  );
  // Keyed by the address a module resolves to, token and all, as the
  // browser matches it.
  const integrity: Record<string, string> = Object.fromEntries(
    addressed.map(({ hash, address }) => [
      address,
      manifest.integrity[hash] ?? "",
    ])
  );
  const importMap = scriptJson({ imports, integrity });
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
  // The page's language, one it speaks or English: never text of the
  // page's own in the document.
  const language = screenLanguageOf(url.searchParams.get("lang"));
  const html = `<!doctype html>
<html lang="${language}">
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
