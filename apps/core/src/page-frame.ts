import {
  fromBase64Url,
  sha256Hex,
  sha256HexOfBytes,
  toBase64,
  toBase64Url,
} from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { log } from "@grasp-os/shared/log";
import {
  artifactSchema,
  pageErrors,
  pageFrameMessage,
  pageFrameReady,
  pageLanguageOf,
  pageModulePath,
  pageNestedDocuments,
  pageNestedInterfaces,
  pagePeerInterfaces,
} from "@grasp-os/shared/pages";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { parse } from "es-module-lexer/js";
import { z } from "zod";

import { signInConfig } from "./auth/config.ts";
import { derivedHmacKey } from "./derived-keys.ts";
import { pageFramePolicy } from "./security-headers.ts";

// The document an App's page runs in, and the only code it can run.
//
// The frontend frames `/page-frame?load=…&artifact=…` with
// `sandbox="allow-scripts"`, once core has handed it that build
// (pages-rpc.ts). It is served from its own address, with a policy of
// its own, because a `srcdoc` or `data:` frame inherits the policy of the
// page around it; only a document loaded over the network gets its own.
//
// That policy names, by hash or by exact address, every script the build
// may run, and nothing else: this document's own two inline scripts (the
// import map and the bootstrap below) and each module of the build at
// `/page-modules/<scope>/<hash>.js`, where core serves exactly those
// bytes (with its imports of the App's other modules carrying the
// address's query, below). No
// `'unsafe-inline'`, no `data:` or `blob:`, no eval. So code that comes
// from anywhere but the build doesn't run, even when the build's own code
// lets it in: HTML an App's server sends that the page renders (an
// `onerror` attribute, a `<script>`), a module the page imports from a
// string (`import("data:…")`), `eval` or `new Function`, a second import
// map. The build core leased, by its hash, is then what the frame runs; a
// change to the App's server changes data, never code. Browsers
// match a policy's addresses on scheme, host, port and the exact path,
// so the policy names the deployment's own origin as people reach it
// (`SIGN_IN.origin`, behind the router), not the address core is called
// at.
//
// It starts in two stages (@grasp-os/shared/pages): the bootstrap says
// it listens, with the `load` its address carries; the runtime says the
// page has mounted. The page waits ten seconds for each and stops the
// frame otherwise (page-host.ts). Only the first message from the page
// that names this load and this build counts, so nothing can restart it
// later; the page in turn talks to the first frame document only.

/** What a frame runs of one page, as core built it. */
export interface FrameCode {
  /** The module to render: its default export is the page. */
  entry: string;
  /** The kit module that renders it (@grasp-os/sdk/page-runtime). */
  runtime: string;
  /**
   * The App's modules, by flat name, each importing the others by address
   * (@grasp-os/compiler's module-addresses.ts).
   */
  modules: Record<string, string>;
  /** Each of `modules`' address, by flat name. */
  addresses: Record<string, string>;
  /** The kit's modules the App's need, by flat name. */
  kit: Record<string, string>;
  css: string;
}

// Who may load a build's frame and modules. No secret goes in a URL's
// path (OWASP): routers, proxies and traces log paths, and Workers can
// redact only the query string (`redact_query_string`, in core's and the
// router's wrangler.jsonc). The router's traces sit in Grasp's own
// account, so a token in a path there would let Grasp staff read a
// client's App code without an audit entry.
//
// A session can't carry it either. The frame is sandboxed without
// `allow-same-origin`, so its origin is opaque: every module request it
// makes is cross-site, and browsers send no cookie of the deployment's
// with it, SameSite=Lax or Strict. A `SameSite=None` cookie would need
// `Access-Control-Allow-Origin: null` with credentials, which lets any
// sandboxed document on the web read with the person's session, and
// browsers that block third-party cookies drop it anyway. A module
// request carries no header we set. So the credential stays in the URL,
// in its query alone, as signed URLs carry theirs: a token core made for
// exactly one scope of modules (`moduleAccess`), short-lived and bound to
// that scope and to modules (no other token of core's passes for it).
// The page gets the frame's token with the build
// (`PageBundle.frameToken`), the frame's document the modules'. A hash
// alone, from an audit entry say, reads nothing. Only a person's call
// mints one, and Grasp staff's calls are refused and audited
// (staff-audit.ts). Every answer on these paths sends no referrer, so no
// token leaves as a Referer; the content hash stays in the path, an
// immutable cache key and no secret.
//
// That holds because every page today is for signed-in people alone: a
// member, or a visitor signed in with a code mailed to them
// (app-visitors.ts). A page for anyone, signed in or not, would have
// browser code as public as any website's, so its scope would be served
// with no token and `public, immutable`, for a CDN to keep, while its data
// stays behind its server functions' own checks. The token check and the
// cache header below are the one place that decision would go.
//
// Modules are kept and served by scope: the kit's (`kitScope`), shared by
// every frame; a build's own, for a published page (its artifact, the
// hash of exactly its code, so of one version of one App's page); and a
// chat's preview's of an App (`previewFrame`), shared by every frame of it
// and every write of its draft. A scope's token reads only that scope's
// modules: a module is kept under its scope with core's MAC over the
// scope, its address and its bytes, checked on serve
// (`pageModuleResponse`), so another scope's address, or bytes moved
// from one, reads nothing.
//
// An App's modules import each other by address relative to their own
// (@grasp-os/compiler's module-addresses.ts), and a relative import keeps
// the path but drops the query. So core serves each App module with its
// imports of the App's others carrying the query it was asked with
// (`withQuery`), as Vite's dev server adds its `?v=` to the imports of
// what it serves, with the same lexer. The kit's modules import each
// other by name, which the import map resolves, query and all.

/** What the tokens' key is for: no other MAC of core's passes for one. */
const accessPurpose = "grasp-os page frame access";

const minute = 60 * 1000;
const hour = 60 * minute;

/** How long a frame's token holds: the page frames it at once. */
const frameAccessMs = 10 * minute;

/**
 * A windowed token (`windowedAccess`) holds until the end of the next
 * window, so every frame in one window names a file at the same address,
 * which the browser caches, and one open for a while can still load one
 * late: between one window and two. A chat's preview's module tokens hold
 * at most an hour, whose frame the page opens again with a fresh token
 * when one expires (@grasp-os/sdk's preview-runtime.ts); a published
 * build's, and a package artifact's, at most six, which a person keeps
 * open through a stretch of a working day.
 */
const accessWindowsMs = { preview: 30 * minute, published: 3 * hour };

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
 * A token for the frame of `artifact`, a chat's preview of its draft as
 * it is now, that takes the draft's updates (`previewScripts`): only core
 * hands one out, for that preview alone. A version of a draft or an App
 * opened read-only is framed with `frameAccess`, and takes none, whatever
 * else the same build was framed for.
 */
export const updatingFrameAccess = async (
  env: Env,
  artifact: string,
  now = Date.now()
): Promise<string> =>
  await accessToken(env, `frame-updates:${artifact}`, now + frameAccessMs);

/**
 * When a token `windowedAccess` makes at `now` expires: the end of the
 * next window of `windowMs`.
 */
export const windowedAccessEnd = (
  now: number,
  windowMs = accessWindowsMs.published
): number => (Math.floor(now / windowMs) + 2) * windowMs;

/**
 * A token for `subject` that holds until the end of the next window of
 * `windowMs` (`windowedAccessEnd`): the same for everything asked in one
 * window. The subject says what it is for (`modules:…`,
 * `package-artifact:…`), so one never passes for another.
 */
export const windowedAccess = async (
  env: Env,
  subject: string,
  now: number,
  windowMs = accessWindowsMs.published
): Promise<string> =>
  await accessToken(env, subject, windowedAccessEnd(now, windowMs));

/** The scope of the kit's modules, which every frame shares. */
const kitScope = "kit";

/**
 * Where a chat's preview of App `app` is staged: the scope its modules
 * are kept in, shared by every frame of it and every write of its draft,
 * and the artifact its frame of `artifact`, a build of the draft, is
 * staged under. The build's own artifact is a hash of its code alone,
 * the same in every chat that previews the same code: its frame here
 * names this scope, so it is this preview's only.
 */
export const previewFrame = async (
  chatId: string,
  app: string,
  artifact: string
): Promise<{ scope: string; artifact: string }> => {
  const scope = await sha256Hex(canonicalJson(["preview", chatId, app]));
  return {
    scope,
    artifact: await sha256Hex(canonicalJson([artifact, scope])),
  };
};

/**
 * A token for the modules of `scope`, in their address's query: for a
 * frame of a chat's preview (`preview`) or of a published build, which
 * hold for different lengths (`accessWindowsMs`).
 */
const moduleAccess = async (
  env: Env,
  scope: string,
  { now, preview }: { now: number; preview: boolean }
): Promise<string> =>
  await windowedAccess(
    env,
    `modules:${scope}`,
    now,
    preview ? accessWindowsMs.preview : accessWindowsMs.published
  );

/**
 * The query parameter an address carries its token in, a page module's
 * or a package artifact's file's: never its path (see above).
 */
export const accessTokenParameter = "token";

/** The query of an address with `token`. */
export const accessQuery = (token: string): string =>
  `?${new URLSearchParams({ [accessTokenParameter]: token }).toString()}`;

/** What a token looks like. */
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
// - A module is served only with core's MAC over its scope, its address
//   and its bytes (`stagedMac`): it can't be changed, or moved to another
//   address or scope, without core's secret.
// - A manifest is served only with core's MAC over it and the build it
//   is for: it can't be written, edited, or moved to another build either.
// - Either one that doesn't pass is refused, logged and deleted, so the
//   next open stages the build again from the sealed bytes.
//
// On top of that, the import map names the sha384 of each module the
// frame loads first (`integrity`, Subresource Integrity), carried in the
// MAC'd manifest, so the browser checks the bytes it got too, whatever
// sits between core and it. Both, rather than SRI alone: a browser that
// doesn't read an import map's `integrity` ignores it, and SRI alone
// would let a tampered object sit in R2 until the build is staged again.
// The check on serve holds for every browser, so it is the one this
// relies on, and the only one for the modules a preview's frame loads
// later (`previewScripts`): an import map can't change once modules
// loaded, a second one only in Chromium, and that inline script would
// need a nonce the page's own code could read; a module the frame
// fetched itself and imported from a `blob:` address can't import
// another so, as no two modules that import each other can name each
// other's `blob:` address, and would need a loader of our own.

const hashPattern = /^[0-9a-f]{64}$/u;

/**
 * What core keeps of a build for its frame: its modules by name, as the
 * addresses they are kept under, the kit's in `kitScope` and the App's in
 * `scope`.
 */
const frameManifestSchema = z
  .strictObject({
    entry: z.string(),
    runtime: z.string(),
    css: z.string(),
    /** Where its App modules are kept: its artifact, or its preview's. */
    scope: z.string().regex(hashPattern),
    kit: z.record(z.string(), z.string().regex(hashPattern)),
    app: z.record(z.string(), z.string().regex(hashPattern)),
    /** Each module's Subresource Integrity, by its address. */
    integrity: z.record(z.string(), z.string().startsWith("sha384-")),
    /** A chat's preview's frame, whose policy takes its updates (`previewScripts`). */
    preview: z.boolean(),
  })
  .refine(
    ({ entry, kit, app, integrity }) =>
      Object.hasOwn(app, entry) &&
      [...Object.values(kit), ...Object.values(app)].every((hash) =>
        Object.hasOwn(integrity, hash)
      )
  );

type FrameManifest = z.infer<typeof frameManifestSchema>;

/** What the manifests' MAC key is for: no other MAC of core's passes for one. */
const manifestPurpose = "grasp-os page frame manifest";

/** What the staged modules' MAC key is for, as `manifestPurpose`. */
const modulePurpose = "grasp-os page module";

/** Core's MAC under `purpose` over `subject` (canonical JSON), base64url. */
const stagedMac = async (
  env: Env,
  purpose: string,
  subject: Json
): Promise<string> => {
  const key = await derivedHmacKey(env, purpose, ["sign", "verify"]);
  return toBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(canonicalJson(subject))
      )
    )
  );
};

/** Whether `mac` is core's under `purpose` over `subject`. */
const isStagedMac = async (
  env: Env,
  purpose: string,
  subject: Json,
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
  const key = await derivedHmacKey(env, purpose, ["sign", "verify"]);
  return await crypto.subtle.verify(
    "HMAC",
    key,
    bytes,
    encoder.encode(canonicalJson(subject))
  );
};

/** What a staged module's MAC covers: where it is kept, and its bytes. */
const moduleSubject = async (
  scope: string,
  hash: string,
  bytes: Uint8Array
): Promise<Json> => [scope, hash, await sha256HexOfBytes(bytes)];

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
  pageErrors.create("page.build_failed", {
    reason: "The page's build has a module larger than one may be.",
  });

/** A kit module's address: the hash of its name and its code. */
const kitAddress = async (name: string, code: string): Promise<string> =>
  await sha256Hex(canonicalJson([name, code]));

/** A module's Subresource Integrity: the sha384 of the bytes served. */
const moduleIntegrity = async (bytes: Uint8Array): Promise<string> =>
  `sha384-${toBase64(
    new Uint8Array(await crypto.subtle.digest("SHA-384", bytes))
  )}`;

const day = 24 * 60 * 60 * 1000;

/**
 * How long a staged build is kept after it was last staged: the clock's
 * sweep deletes what is older (`sweepPageFrames`).
 */
export const frameKeepMs = 30 * day;

/**
 * How old a staged manifest or module may be and still be used as it is:
 * past this, staging it again puts it anew, so one in use is never as old
 * as the sweep's limit.
 */
const frameRefreshMs = frameKeepMs / 2;

const framesPrefix = "page-frames/";
const modulesPrefix = "page-modules/";

/**
 * The format of a staged manifest (`frameManifestSchema`), in its key: a
 * manifest staged in another format is under another key, so no open
 * finds it, and the build is staged again in this one, rather than read
 * as a manifest it isn't. Raised with each change of the format: `3`
 * keeps modules by scope. What is left under an older key goes with the
 * sweep (`sweepPageFrames`), which reads the whole prefix.
 */
const frameManifestFormat = 3;

export const frameKey = (artifact: string): string =>
  `${framesPrefix}${artifact}.v${frameManifestFormat}.json`;

const moduleKey = (scope: string, hash: string): string =>
  `${modulesPrefix}${scope}/${hash}.js`;

/**
 * `/page-modules/<scope>/<hash>.js?token=<token>`: one module, as a
 * frame imports it. A preview's frame may put a number of its own before
 * the hash (`/<visit>/<hash>.js`): the same module, at an address the
 * frame hasn't evaluated yet, so it evaluates it afresh (@grasp-os/sdk's
 * preview-updates.ts); the modules it imports, relative to it, are then
 * evaluated afresh too. One asked without a token is a module all the
 * same, refused as one.
 */
const modulePath = new RegExp(
  `^${pageModulePath}/(?<scope>${kitScope}|[0-9a-f]{64})/(?:\\d{1,9}/)?(?<hash>[0-9a-f]{64})\\.js$`,
  "u"
);

/** An import of another of the App's modules, as the compiler writes it. */
const appModuleSpecifier = /^\.\/[0-9a-f]{64}\.js$/u;

/** Reads a module's bytes as they are, a byte order mark included. */
const moduleDecoder = new TextDecoder("utf-8", {
  fatal: false,
  ignoreBOM: true,
});

/**
 * `bytes`, an App module, with each import of the App's other modules
 * (`./<address>.js`, static, re-exported or `import()`) carrying `query`:
 * resolved relative to the module, an import keeps its path but drops
 * the query, and the token in it is what lets the import in. Found with
 * the lexer that wrote them (@grasp-os/compiler's module-addresses.ts),
 * so a string that merely spells an address is left as it is. A module
 * that imports none of them is its bytes exactly.
 */
const withQuery = (bytes: Uint8Array, query: string): Uint8Array => {
  const code = moduleDecoder.decode(bytes);
  const [imports] = parse(code);
  const sites = imports.flatMap(({ specifier, start, end, type }) =>
    typeof specifier === "string" && appModuleSpecifier.test(specifier)
      ? [{ specifier, start, end, type }]
      : []
  );
  if (sites.length === 0) {
    return bytes;
  }
  let text = "";
  let at = 0;
  for (const { specifier, start, end, type } of sites) {
    const addressed = `${specifier}${query}`;
    text += code.slice(at, start);
    // An `import()`'s span is its argument, quotes and all.
    text += type === "dynamic" ? JSON.stringify(addressed) : addressed;
    at = end;
  }
  return encoder.encode(text + code.slice(at));
};

/** One module to stage: where it is kept, and its bytes. */
interface StagedModule {
  scope: string;
  hash: string;
  bytes: Uint8Array;
}

/**
 * Puts `body` at `key` with `mac`, core's MAC over it, unless it is kept
 * there already: under that very MAC (one made with a key since rotated
 * is put anew, or it would be refused as corrupt on every serve), and
 * recently enough that the sweep won't take it soon. Two stagings at once
 * both write the same bytes.
 */
const keep = async (
  env: Env,
  key: string,
  body: Uint8Array | string,
  mac: string,
  now: Date
): Promise<void> => {
  const kept = await env.FILES.head(key);
  if (
    kept !== null &&
    kept.customMetadata?.mac === mac &&
    now.getTime() - kept.uploaded.getTime() < frameRefreshMs
  ) {
    return;
  }
  await env.FILES.put(key, body, { customMetadata: { mac } });
};

/** Keeps `modules` where frames load them, each with core's MAC (`keep`). */
export const stageModules = async (
  env: Env,
  modules: readonly StagedModule[],
  now = new Date()
): Promise<void> => {
  if (modules.some(({ bytes }) => bytes.byteLength > frameObjectMaxBytes)) {
    throw oversizedBuild();
  }
  await Promise.all(
    modules.map(async ({ scope, hash, bytes }) => {
      const mac = await stagedMac(
        env,
        modulePurpose,
        await moduleSubject(scope, hash, bytes)
      );
      await keep(env, moduleKey(scope, hash), bytes, mac, now);
    })
  );
};

/** The App's modules of `code`, kept under `scope` at their addresses. */
export const appModules = (
  { modules, addresses }: Pick<FrameCode, "modules" | "addresses">,
  scope: string
): StagedModule[] =>
  Object.entries(modules).map(([name, code]) => ({
    scope,
    hash: addresses[name] ?? "",
    bytes: encoder.encode(code),
  }));

/** Whether every kit module of `manifest` is stored (`servedIntegrity` reads the App's). */
const allStaged = async (
  env: Env,
  { kit }: Pick<FrameManifest, "kit">
): Promise<boolean> => {
  const found = await Promise.all(
    Object.values(kit).map(
      async (hash) => await env.FILES.head(moduleKey(kitScope, hash))
    )
  );
  return found.every((head) => head !== null);
};

/**
 * The Subresource Integrity of each App module of `manifest`, by its
 * address, as core serves it under `query` (`withQuery`), or null when
 * one isn't kept as core staged it: the bytes in R2 are checked against
 * the sha384 the manifest names (under core's MAC), so the import map
 * never vouches for bytes core didn't stage. One that differs goes,
 * so the next open stages it again.
 */
const servedIntegrity = async (
  env: Env,
  { scope, app, integrity }: FrameManifest,
  query: string
): Promise<Record<string, string> | null> => {
  const found = await Promise.all(
    [...new Set(Object.values(app))].map(async (hash) => {
      const key = moduleKey(scope, hash);
      const module = await env.FILES.get(key);
      if (module === null) {
        return null;
      }
      if (module.size > frameObjectMaxBytes) {
        await module.body.cancel();
      } else {
        const bytes = new Uint8Array(await module.arrayBuffer());
        if ((await moduleIntegrity(bytes)) === integrity[hash]) {
          return [
            hash,
            await moduleIntegrity(withQuery(bytes, query)),
          ] as const;
        }
      }
      log.error("page_frame.module_corrupt", { hash });
      await env.FILES.delete(key);
      return null;
    })
  );
  return found.includes(null)
    ? null
    : Object.fromEntries(found.filter((entry) => entry !== null));
};

/**
 * Keeps a build where its frame loads it: its App modules under `scope`
 * (its artifact, or its preview's, `previewFrame`) at their addresses,
 * the kit's under `kitScope` at theirs (`stageModules`), and the build's
 * manifest under its artifact, with core's MAC (checked on serve, as
 * above), each only when not kept so already (`keep`). The modules go
 * first, so a manifest is never there without
 * them; the sweep may still take one (it can't delete only if
 * unchanged), which the frame's document notices, and the next open puts
 * back. Two opens at once both write it, the same bytes. A chat's
 * preview's build is staged as one (`preview`), which only its policy
 * says.
 */
export const stageFrame = async (
  env: Env,
  artifact: string,
  code: FrameCode,
  {
    preview = false,
    scope = artifact,
    now = new Date(),
  }: { preview?: boolean; scope?: string; now?: Date } = {}
): Promise<void> => {
  const kit = await Promise.all(
    Object.entries(code.kit).map(async ([name, source]) => ({
      name,
      scope: kitScope,
      hash: await kitAddress(name, source),
      bytes: encoder.encode(source),
    }))
  );
  const app = appModules(code, scope);
  await stageModules(env, [...kit, ...app], now);
  const manifest: FrameManifest = {
    entry: code.entry,
    runtime: code.runtime,
    css: code.css,
    scope,
    kit: Object.fromEntries(kit.map(({ name, hash }) => [name, hash])),
    app: code.addresses,
    integrity: Object.fromEntries(
      await Promise.all(
        [...kit, ...app].map(
          async ({ bytes, hash }) =>
            [hash, await moduleIntegrity(bytes)] as const
        )
      )
    ),
    preview,
  };
  const text = JSON.stringify(manifest);
  if (encoder.encode(text).byteLength > frameObjectMaxBytes) {
    throw oversizedBuild();
  }
  await keep(
    env,
    frameKey(artifact),
    text,
    await stagedMac(env, manifestPurpose, [artifact, text]),
    now
  );
};

/** Where the sweep left off: which prefix, and R2's cursor in it. */
const sweepKey = "page-frames-sweep.json";

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
 * `frameKeepMs` before `now`, from the clock: in code, not a bucket rule,
 * so it runs wherever core does. One page of one prefix a run, at most
 * `sweepBatch` objects, from where the last run stopped; once a prefix is
 * done, the next run starts the other.
 */
export const sweepPageFrames = async (env: Env, now: Date): Promise<void> => {
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
      "content-security-policy": pageFramePolicy(scripts),
      "cache-control": cache,
      // Its address may carry a token.
      "referrer-policy": "no-referrer",
    },
  });

/**
 * A module, as a frame imports it, or null when the path isn't one: only
 * with a token core made for its scope that hasn't expired, and only
 * bytes core's MAC says it kept there.
 */
export const pageModuleResponse = async (
  env: Env,
  url: URL
): Promise<Response | null> => {
  const { scope, hash } = modulePath.exec(url.pathname)?.groups ?? {};
  if (scope === undefined || hash === undefined) {
    // Under the modules' path but no module's address (one with a token
    // in its path, say): nothing, rather than the frontend's page.
    return url.pathname.startsWith(`${pageModulePath}/`)
      ? refused(404, [], "no-store")
      : null;
  }
  const token = url.searchParams.get(accessTokenParameter);
  if (!(await hasFrameAccess(env, `modules:${scope}`, token))) {
    return refused(403);
  }
  const key = moduleKey(scope, hash);
  const module = await env.FILES.get(key);
  if (module === null) {
    // Its address may carry a token: no cache keeps the miss.
    return refused(404, [], "no-store");
  }
  if (module.size > frameObjectMaxBytes) {
    // Larger than core stages: not read.
    await module.body.cancel();
    log.error("page_frame.module_corrupt", { hash, bytes: module.size });
    await env.FILES.delete(key);
    return refused(404, [], "no-store");
  }
  const bytes = new Uint8Array(await module.arrayBuffer());
  if (
    !(await isStagedMac(
      env,
      modulePurpose,
      await moduleSubject(scope, hash, bytes),
      module.customMetadata?.mac
    ))
  ) {
    // Not what core staged here: never served. Gone, so the frame's
    // document finds it missing and the next open stages the build
    // again; meanwhile a miss nothing caches.
    log.error("page_frame.module_corrupt", { hash });
    await env.FILES.delete(key);
    return refused(404, [], "no-store");
  }
  const served =
    scope === kitScope ? bytes : withQuery(bytes, accessQuery(token ?? ""));
  return new Response(served, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      // The frame's origin is opaque, so its module requests are
      // cross-origin, without cookies: the token in the address is what
      // lets it in.
      "access-control-allow-origin": "*",
      // Its address is its content, for as long as its token holds: in
      // the browser's cache alone, never a shared one.
      "cache-control": "private, max-age=3600, immutable",
      // A module's imports send its address, token and all, as their
      // Referer unless it says otherwise: a module's fetches take the
      // referrer policy of the module that imports (HTML).
      "referrer-policy": "no-referrer",
    },
  });
};

// The bootstrap also tells the page each time the person acts in this
// frame (a click, a tap, a key), over a port of its own: the page counts a
// page's navigation as the person's only on such an act
// (page-host.ts), never on activation the frame may have focused itself
// into. The page's code shares this realm, so what reports runs before
// any of it, and keeps what it needs where that code never reaches:
// - the port, and the intrinsics it reports and listens with, are taken
//   as this script starts, before any module loads, and held in its
//   closure only, never on a global or a prototype; patching
//   `MessagePort.prototype` or `EventTarget.prototype` later changes
//   nothing here;
// - its listeners are the window's first, in the capture phase, so no
//   listener of the page's runs before them or stops them;
// - it reports only an event the browser made (`isTrusted`, each event's
//   own property that no script can redefine), never one a script
//   dispatched;
// - one gesture is one act: a pointer's press (never its release, nor the
//   mouse and touch events the same gesture fires too) and a key's first
//   press (never its repeats while held, read with the getter taken at
//   start), so a page can't turn one click or one held key into many
//   navigations;
// - the report carries nothing: what counts is that it came over this
//   port, which only this script holds. The page's ports and the page's
//   window are its own to post on, and the page reads no act from them.
//
// It also keeps the page from making a document of its own, before any
// of the page's code runs. A nested document, even an empty
// `about:blank` one, which `frame-src 'none'` doesn't stop, is a realm
// with its own WebRTC (a peer connection to a TURN server is a way out no
// policy closes, security-headers.ts) and its own network. The frame's
// policy makes every sink of the HTML parser (`innerHTML`,
// `insertAdjacentHTML`, `DOMParser`, `document.write`, `srcdoc`, …)
// refuse a string (Trusted Types, with no policy allowed), and this script
// closes what is left, so a page can't create a nested realm:
// - It checks that the browser enforces that first, by giving a detached
//   element's `innerHTML` a string: a browser that takes it would parse a
//   page's markup, nested documents and all, so the page isn't
//   started there, and the page says the browser is too old.
// - Each WebRTC interface becomes an undefined, non-configurable property
//   of the window, so no script gets it back there.
// - `createElement`, `createElementNS` and `createDocument` convert their
//   arguments once, call the browser's own, and refuse what came out when
//   it is a nested document by its local name or its interface, read with
//   getters taken at start: a namespace prefix (`x:iframe`), a name whose
//   `toString` answers differently each time, or a customized built-in
//   all end there.
// - The nested documents' interfaces are taken at start and replaced
//   with stand-ins that construct nothing (React reads
//   `window.HTMLIFrameElement` with `instanceof`, which they still
//   answer): no class can extend them. `XSLTProcessor`, which makes
//   markup into nodes without the parser, is gone.
// - `document.execCommand("insertHTML")` is refused, and so is the
//   Sanitizer API (`setHTML` on an element or a shadow root,
//   `Document.parseHTML`), which builds elements with a parser of its own
//   that Trusted Types doesn't govern, and whose configuration can be
//   widened to make a `<link>` with an address; `Document.parseHTMLUnsafe`
//   too, whatever Trusted Types does with it.
// - An element's `contentWindow` and `contentDocument` answer null.
// - `document.open`, `write` and `writeln` are refused: opening the
//   document again clears every listener of the document and the
//   window, these guards' among them, and Trusted Types covers only the
//   markup `write` takes, not an `open()` with none. Nothing else a
//   script can do resets them in place: a navigation leaves the page's
//   code behind (and the page stops a frame that leaves), and reloading
//   runs this script again.
// - Nor can a `<link>` it makes have an address: a `preconnect` opens a
//   connection to whatever address it names, a lookup and a handshake
//   that carry the name out, which neither this policy nor
//   `X-DNS-Prefetch-Control` governs. Making a link stays allowed, as
//   the kit's module loader makes one as it loads, only to ask which
//   `rel` the browser supports; giving one an `href` is refused, by
//   its property and every way an attribute is set, so a link connects
//   nowhere. Pages style with the kit, and load nothing a link would.
// - Markup pasted or dropped never becomes nodes: the window's first
//   capturing listener cancels the browser's own handling of every
//   `paste` and `drop`, before anything about it is read, so it holds
//   whatever the event says it carries. It asks neither where nor what:
//   at the window, an event from inside a shadow root names its host,
//   and WebKit pasted markup that a check of the event's types let
//   through. A paste's plain text is inserted instead, into whatever
//   has focus (nothing, when nothing editable does), so a page's
//   fields take text, formatting dropped; a drop inserts nothing. The
//   page's own listeners still hear both, and read their files. The
//   text goes in only after the page's listeners on its elements, from
//   a bubbling listener on the window, and not at all when the page cancelled the paste itself
//   (its own `preventDefault`, as a field that splits pasted tags
//   calls, or `returnValue = false`) or stopped it on the way: a page
//   that handles a paste gets the text once, its way. To the page,
//   both events look as the browser handed them: not cancelled until it
//   cancels them itself (`defaultPrevented`). A paste listener the
//   page puts on the window itself comes after the insertion, and
//   cancelling there is too late for it. A dropped file reaches a file
//   field only through the field's own drop handler (the kit's has one).
//
// All of it is one closure, so nothing it keeps is reachable from the
// page's code. A classic script's top-level `const` is a binding of the
// realm's global scope, which every later script and module resolves a
// free name against (a page's `declare const createElement` compiles
// away and then reads it): the browser's own methods kept there would
// hand the page a way past every lock. Inside the closure they exist
// only for the wrappers that use them. That, the locks being
// non-configurable, and the frame's policy are the boundary. The
// pages' lint rules against WebRTC (@grasp-os/compiler's page-rules.ts)
// only tell an author early; they read source, which a page can always
// spell some other way, and nothing relies on them.
const bootstrap = `"use strict";
(() => {
const apply = Reflect.apply;
const enforced = (() => {
  try {
    document.createElement("div").innerHTML = "<b></b>";
    return false;
  } catch {
    return true;
  }
})();
// Descriptors with no prototype: \`Object.defineProperty\` reads \`get\`,
// \`set\` and \`writable\` through one, which the page's code can fill.
const lock = (target, name, descriptor) => {
  if (Object.getOwnPropertyDescriptor(target, name)?.configurable !== false) {
    Object.defineProperty(target, name, { __proto__: null, ...descriptor, enumerable: false, configurable: false });
  }
};
for (const name of ${JSON.stringify(pagePeerInterfaces)}) {
  lock(window, name, { value: undefined, writable: false });
}
const refusedNames = new Set(${JSON.stringify(pageNestedDocuments)});
const nestedInterfaces = ${JSON.stringify(pageNestedInterfaces)}.flatMap((name) => {
  const found = Object.getOwnPropertyDescriptor(window, name)?.value;
  return typeof found === "function" ? [[name, found]] : [];
});
const localNameOf = Object.getOwnPropertyDescriptor(Element.prototype, "localName").get;
const rootOf = Object.getOwnPropertyDescriptor(Document.prototype, "documentElement").get;
// Every intrinsic the locks use at call time is taken now: the page's
// code may replace \`String\`, \`Set.prototype.has\` or \`Array.prototype.some\`.
const toText = String;
const toLower = String.prototype.toLowerCase;
const hasInstance = Function.prototype[Symbol.hasInstance];
const has = Set.prototype.has;
const some = Array.prototype.some;
const Refusal = DOMException;
const isRefused = (node) =>
  node !== null &&
  typeof node === "object" &&
  (apply(has, refusedNames, [apply(toLower, toText(apply(localNameOf, node, [])), [])]) ||
    apply(some, nestedInterfaces, [(entry) => apply(hasInstance, entry[1], [node])]));
const refuse = () => {
  throw new Refusal("A page makes no nested document, and no link with an address.", "NotSupportedError");
};
const asName = (value) => (value === null || value === undefined ? value : toText(value));
const createElement = Document.prototype.createElement;
const createElementNS = Document.prototype.createElementNS;
const createDocument = DOMImplementation.prototype.createDocument;
const execCommand = Document.prototype.execCommand;
lock(Document.prototype, "createElement", {
  writable: false,
  value: function (tag, options) {
    const made = apply(createElement, this, [toText(tag), options]);
    return isRefused(made) ? refuse() : made;
  },
});
lock(Document.prototype, "createElementNS", {
  writable: false,
  value: function (namespace, tag, options) {
    const made = apply(createElementNS, this, [asName(namespace), toText(tag), options]);
    return isRefused(made) ? refuse() : made;
  },
});
lock(DOMImplementation.prototype, "createDocument", {
  writable: false,
  value: function (namespace, tag, doctype) {
    const made = apply(createDocument, this, [asName(namespace), asName(tag), doctype]);
    return isRefused(apply(rootOf, made, [])) ? refuse() : made;
  },
});
for (const owner of [Document.prototype, globalThis.HTMLDocument?.prototype]) {
  for (const name of ["open", "write", "writeln"]) {
    if (owner !== undefined && Object.hasOwn(owner, name)) {
      lock(owner, name, { writable: false, value: refuse });
    }
  }
}
lock(Document.prototype, "execCommand", {
  writable: false,
  value: function (command, showUI, value) {
    const asked = toText(command);
    return apply(toLower, asked, []) === "inserthtml" ? refuse() : apply(execCommand, this, [asked, showUI, value]);
  },
});
for (const [name, found] of nestedInterfaces) {
  for (const member of ["contentWindow", "contentDocument"]) {
    if (member in found.prototype) {
      lock(found.prototype, member, { get: () => null });
    }
  }
  if ("getSVGDocument" in found.prototype) {
    lock(found.prototype, "getSVGDocument", { writable: false, value: () => null });
  }
  const standIn = function () {
    refuse();
  };
  lock(standIn, Symbol.hasInstance, { writable: false, value: (node) => apply(hasInstance, found, [node]) });
  lock(window, name, { value: standIn, writable: false });
}
lock(window, "XSLTProcessor", { value: undefined, writable: false });
for (const [owner, name] of [[Element.prototype, "setHTML"], [globalThis.ShadowRoot?.prototype, "setHTML"], [Document, "parseHTML"], [Document, "parseHTMLUnsafe"]]) {
  if (owner !== undefined && typeof owner[name] === "function") {
    lock(owner, name, { writable: false, value: refuse });
  }
}
const attrNameOf = Object.getOwnPropertyDescriptor(Attr.prototype, "localName").get;
const endsWith = String.prototype.endsWith;
const isLink = (node) => apply(toLower, toText(apply(localNameOf, node, [])), []) === "link";
const isAddress = (name) => {
  const lower = apply(toLower, toText(name), []);
  return lower === "href" || apply(endsWith, lower, [":href"]);
};
// Fixed parameters and literal arrays only: a rest array's missing
// index would read, and its write would call, whatever the page put on
// Array.prototype at that index.
const setAttribute = Element.prototype.setAttribute;
const setAttributeNS = Element.prototype.setAttributeNS;
const toggleAttribute = Element.prototype.toggleAttribute;
lock(Element.prototype, "setAttribute", {
  writable: false,
  value: function (name, value) {
    const named = toText(name);
    return isLink(this) && isAddress(named) ? refuse() : apply(setAttribute, this, [named, value]);
  },
});
lock(Element.prototype, "setAttributeNS", {
  writable: false,
  value: function (namespace, name, value) {
    const named = toText(name);
    return isLink(this) && isAddress(named) ? refuse() : apply(setAttributeNS, this, [namespace, named, value]);
  },
});
lock(Element.prototype, "toggleAttribute", {
  writable: false,
  value: function (name, force) {
    const named = toText(name);
    // A force left out is not one given as undefined: the browser counts.
    const passed = arguments.length > 1 ? [named, force] : [named];
    return isLink(this) && isAddress(named) ? refuse() : apply(toggleAttribute, this, passed);
  },
});
for (const [owner, name] of [[Element.prototype, "setAttributeNode"], [Element.prototype, "setAttributeNodeNS"], [NamedNodeMap.prototype, "setNamedItem"], [NamedNodeMap.prototype, "setNamedItemNS"]]) {
  const set = owner[name];
  lock(owner, name, {
    writable: false,
    value: function (attr) {
      return isAddress(apply(attrNameOf, attr, [])) ? refuse() : apply(set, this, [attr]);
    },
  });
}
const linkHref = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, "href");
lock(HTMLLinkElement.prototype, "href", { get: linkHref.get, set: refuse });
const listen = EventTarget.prototype.addEventListener;
const unlisten = EventTarget.prototype.removeEventListener;
const preventDefault = Event.prototype.preventDefault;
const getData = DataTransfer.prototype.getData;
const clipboardOf = Object.getOwnPropertyDescriptor(ClipboardEvent.prototype, "clipboardData").get;
const define = Object.defineProperty;
const weakAdd = WeakSet.prototype.add;
const weakHas = WeakSet.prototype.has;
// Cancels the browser's own handling of a paste or drop, and shows the
// page the event as if nothing had: its cancelling, by any of the
// event's ways, is recorded for the paste's insertion to read.
const cancelledByPage = new WeakSet();
const shield = (event) => {
  apply(preventDefault, event, []);
  const cancel = () => {
    apply(weakAdd, cancelledByPage, [event]);
  };
  const cancelled = () => apply(weakHas, cancelledByPage, [event]);
  define(event, "preventDefault", { __proto__: null, value: cancel });
  define(event, "defaultPrevented", { __proto__: null, get: cancelled });
  define(event, "returnValue", {
    __proto__: null,
    get: () => !cancelled(),
    set: (value) => {
      if (!value) {
        cancel();
      }
    },
  });
};
apply(listen, window, ["paste", shield, true]);
apply(listen, window, ["drop", shield, true]);
apply(listen, window, ["paste", (event) => {
  if (apply(weakHas, cancelledByPage, [event])) {
    return;
  }
  const data = apply(clipboardOf, event, []);
  const text = data === null ? "" : apply(getData, data, ["text/plain"]);
  // Nothing to insert (an image, a file) replaces no selection either.
  if (text !== "") {
    apply(execCommand, document, ["insertText", false, text]);
  }
}, false]);
const post = MessagePort.prototype.postMessage;
const repeatOf = Object.getOwnPropertyDescriptor(KeyboardEvent.prototype, "repeat").get;
const load = new URLSearchParams(location.search).get("load");
const bundle = JSON.parse(document.getElementById("page").textContent);
const reportActs = (port) => {
  const pressed = (event) => {
    if (event.isTrusted === true) {
      apply(post, port, [null]);
    }
  };
  const keyed = (event) => {
    if (event.isTrusted === true && apply(repeatOf, event, []) !== true) {
      apply(post, port, [null]);
    }
  };
  apply(listen, window, ["pointerdown", pressed, true]);
  apply(listen, window, ["keydown", keyed, true]);
};
const start = (event) => {
  const { data, ports } = event;
  if (
    event.source !== parent ||
    data?.type !== "${pageFrameMessage}" ||
    data.load !== load ||
    data.artifact !== bundle.artifact ||
    ports.length !== 4
  ) {
    return;
  }
  apply(unlisten, window, ["message", start]);
  reportActs(ports[3]);
  const style = document.createElement("style");
  style.textContent = bundle.css;
  document.head.append(style);
  import(bundle.runtime).then((runtime) =>
    runtime.runPage(
      ports[0],
      bundle.entry,
      { load, artifact: bundle.artifact, generation: data.generation },
      ports[1],
      ports[2]
    )
  );
};
// A message from any window but the page, or the frame's own (which
// libraries post to themselves to schedule work), never reaches the
// page's code: another App's frame on the same page (a side panel)
// could otherwise hand it what it read, for its own App to send on. This
// closes the overt way between two Apps' frames, not every covert one:
// two Apps whose builders collude, shown side by side, can still signal
// through what the tab shares (its history's length, timing). What they
// pass on then still leaves only through the second App's own grants,
// which an admin gave it, each call audited.
const sourceOf = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "source").get;
const stopNow = Event.prototype.stopImmediatePropagation;
const page = parent;
const own = window;
apply(listen, window, ["message", (event) => {
  const source = apply(sourceOf, event, []);
  if (source !== page && source !== own) {
    apply(stopNow, event, []);
  }
}, true]);
if (enforced) {
  apply(listen, window, ["message", start]);
}
parent.postMessage({ type: "${pageFrameReady}", load, supported: enforced }, "*");
})();`;

/**
 * `value` as JSON to put between `<script>` tags: a `<` would let the
 * text end the element, so each is written as the escape JSON reads the
 * same.
 */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value).replaceAll("<", "\\u003c");

// A chat's preview takes each write of its draft in the frame it has open
// (spec 19.2.1), as Vite's dev server takes a change: core stages the
// write's modules under the preview's scope (`previewFrame`), and the page
// hands the frame the address of its page's module, which the frame
// imports from its own module address and swaps in with React Fast
// Refresh, keeping what the page holds (@grasp-os/sdk's
// preview-runtime.ts). Only the modules a write changed have new
// addresses, so only they load. A frame's policy is fixed when its
// document loads, so it can't name those addresses: a preview's frame,
// and only one both staged as a preview's build (`preview`, under core's
// MAC) and framed with a token core made for taking updates
// (`updatingFrameAccess`, the draft as it is now alone), allows its whole
// module directory (`previewScripts`), the preview's scope under the
// frame's token. A version opened read-only is the same build at times,
// so the token decides, not the build. The ways it could fail, and what
// closes each:
//
// - The production frame's policy loosens: it is built from the same
//   list without `previewScripts`, and a preview's build has an artifact
//   of its own profile and preview, never one a production frame is
//   staged under (pages.ts, `previewFrame`).
// - The frame runs a module of another App, another chat, or a release
//   revoked since: the directory is its own preview's scope, under a
//   token for that scope alone, and core serves a module there only with
//   its MAC over that scope (`pageModuleResponse`), which only staging
//   the preview's own draft puts there (chats-rpc.ts, which refuses
//   anyone who doesn't build the App).
// - The frame runs other bytes than core built: core checks its MAC over
//   the bytes as it serves them.
// - Draft code loads a module of its own: it already runs unreviewed
//   draft code there, with fixture data, no resources, no network
//   (`connect-src 'none'`) and an opaque origin; the directory adds only
//   modules of the same draft. Still no `data:`, no `blob:`, no eval and
//   no inline script but the document's own.

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
 * (no manifest) gets a document that runs nothing. The kit's modules
 * come in its import map, by flat name, and the page's module by its
 * address, each address with a token for its scope as a segment of it.
 */
export const pageFrameResponse = async (
  env: Env,
  url: URL
): Promise<Response> => {
  const artifact = artifactSchema.safeParse(url.searchParams.get("artifact"));
  if (!artifact.success) {
    return refused(404);
  }
  const token = url.searchParams.get("token");
  // Framed to take a draft's updates (`updatingFrameAccess`), or as it is.
  const updating = await hasFrameAccess(
    env,
    `frame-updates:${artifact.data}`,
    token
  );
  if (
    !updating &&
    !(await hasFrameAccess(env, `frame:${artifact.data}`, token))
  ) {
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
      (await isStagedMac(
        env,
        manifestPurpose,
        [artifact.data, text],
        stored.customMetadata?.mac
      ))
      ? JSON.parse(text)
      : undefined
  );
  if (!parsed.success) {
    // Not a manifest core staged for this build: it runs nothing, and
    // goes, so the page's next open stages the build again.
    log.error("page_frame.manifest_corrupt", { artifact: artifact.data });
    await env.FILES.delete(frameKey(artifact.data));
    return refused(404, [], "no-store");
  }
  const manifest = parsed.data;
  const origin = signInConfig(env)?.origin ?? url.origin;
  const access = { now: Date.now(), preview: manifest.preview };
  const kitQuery = accessQuery(await moduleAccess(env, kitScope, access));
  const appQuery = accessQuery(await moduleAccess(env, manifest.scope, access));
  const appIntegrity = await servedIntegrity(env, manifest, appQuery);
  if (appIntegrity === null || !(await allStaged(env, manifest))) {
    // A module the sweep took from under it, or one not as core staged
    // it: the manifest goes too, so the page's next open stages the whole
    // build again.
    await env.FILES.delete(frameKey(artifact.data));
    return refused(404, [], "no-store");
  }
  const kitDirectory = `${origin}${pageModulePath}/${kitScope}/`;
  const appDirectory = `${origin}${pageModulePath}/${manifest.scope}/`;
  // Each address with its token in the query, as the browser asks for it;
  // the policy names it by its path, which is all a policy matches.
  const kit = Object.entries(manifest.kit).map(([name, hash]) => ({
    name,
    path: `${kitDirectory}${hash}.js`,
    address: `${kitDirectory}${hash}.js${kitQuery}`,
    integrity: manifest.integrity[hash] ?? "",
  }));
  const app = Object.values(manifest.app).map((hash) => ({
    path: `${appDirectory}${hash}.js`,
    address: `${appDirectory}${hash}.js${appQuery}`,
    integrity: appIntegrity[hash] ?? "",
  }));
  const imports: Record<string, string> = Object.fromEntries(
    kit.map(({ name, address }) => [name, address])
  );
  // Keyed by the address a module resolves to, as the browser matches it:
  // the App's modules import each other relative to their own, under the
  // query core serves them with.
  const integrity: Record<string, string> = Object.fromEntries(
    [...kit, ...app].map(({ address, integrity: hash }) => [address, hash])
  );
  const importMap = scriptJson({ imports, integrity });
  const page = scriptJson({
    artifact: artifact.data,
    entry: `${appDirectory}${manifest.app[manifest.entry] ?? ""}.js${appQuery}`,
    runtime: manifest.runtime,
    css: manifest.css,
  });
  // A preview's build, framed to take its draft's updates: its whole
  // module directory, for the modules its draft's writes add.
  const previewScripts = manifest.preview && updating ? [appDirectory] : [];
  const scripts = [
    await hashSource(bootstrap),
    await hashSource(importMap),
    ...new Set([...kit, ...app].map(({ path }) => path)),
    ...previewScripts,
  ];
  // The page's language, one it speaks or English: never text of the
  // page's own in the document.
  const language = pageLanguageOf(url.searchParams.get("lang"));
  const html = `<!doctype html>
<html lang="${language}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>Page</title>
    <script type="importmap">${importMap}</script>
    <script type="application/json" id="page">${page}</script>
    <script>${bootstrap}</script>
  </head>
  <body></body>
</html>
`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": pageFramePolicy(scripts),
      // Its address carries its token, and so does every module's it
      // loads: neither leaves as a Referer.
      "referrer-policy": "no-referrer",
      // Never kept, not even to revalidate: its import map carries module
      // tokens minted for this open, and each open checks the build and
      // its bytes again (`servedIntegrity`). A frame is framed once, with
      // a token that holds minutes, so nothing would be saved by keeping it.
      "cache-control": "no-store",
      // No name a page writes is looked up ahead of time: a lookup is a
      // packet to whoever answers for that name.
      "x-dns-prefetch-control": "off",
    },
  });
};
