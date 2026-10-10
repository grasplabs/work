import {
  catalogLogoRequestSchema,
  connectErrors,
} from "@grasp-os/shared/connect";
import type { CatalogLogo, CatalogLogoType } from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";

import { listedToolkits } from "./catalog.ts";
import { ComposioError, composioKey, readCappedBytes } from "./composio.ts";

// Catalog entries' logos. The Integrations page shows each toolkit's logo
// from the deployment's own origin: core asks connect, and connect fetches
// it from Composio's logo host, so the browser never calls Composio (an
// external call outside connect, which would tell Composio who looks, and
// which the page's policy refuses anyway).
//
// Each safeguard, and why:
// - Only the address Composio's toolkit list gives, and only on its logo
//   host over https (`composioLogoHost`, src/catalog.ts): a toolkit's
//   logo is fetched for a toolkit the catalog lists, never for a URL a
//   caller names. No key goes with it, and a redirect is never followed.
// - What comes back is untrusted. It is read up to `maxLogoBytes` as it
//   arrives, and served only if its bytes are one of `catalogLogoTypes`,
//   as the bytes themselves say: Composio's `content-type` isn't relied on,
//   and the type core sends is ours. An SVG can carry script, so core
//   serves logos under a policy that runs none (security-headers.ts).
// - A logo that is no image, too big, or answered with an error is none:
//   the page draws the entry's first letter. That answer is kept as a logo
//   is; one that didn't come (no answer in time, a 5xx, a 429) is asked
//   again next time.

/** Largest logo connect serves, in bytes. */
export const maxLogoBytes = 256 * 1024;

/** How long one request for a logo may take. */
const logoTimeoutMs = 10_000;

/** How long a logo is kept: toolkits rarely change theirs. */
const logoTtlMs = 24 * 60 * 60 * 1000;

/** Most logo bytes kept per isolate: a few hundred logos. */
const maxCachedBytes = 8 * 1024 * 1024;

/** A logo connect fetched, or `null` for one it refused. */
interface CachedLogo {
  expiresAt: number;
  logo: CatalogLogo | null;
}

// Per isolate, by the logo's address (no key goes with it). Loads under way
// are shared, as the catalog's are (src/catalog.ts).
const logos = new Map<string, CachedLogo>();
const loading = new Map<string, Promise<CatalogLogo | null>>();

/** Forgets every logo kept, so the next is fetched afresh. */
export const forgetCatalogLogos = (): void => {
  logos.clear();
  loading.clear();
};

const sizeOf = (cached: CachedLogo | undefined): number =>
  cached?.logo?.bytes.byteLength ?? 0;

/** Keeps `logo` under `source`, dropping expired logos, then the oldest. */
const keep = (source: string, logo: CatalogLogo | null): void => {
  const now = Date.now();
  for (const [each, { expiresAt }] of logos) {
    if (expiresAt <= now) {
      logos.delete(each);
    }
  }
  logos.delete(source);
  const kept = { expiresAt: now + logoTtlMs, logo };
  let bytes = sizeOf(kept);
  for (const each of logos.values()) {
    bytes += sizeOf(each);
  }
  for (const [oldest, each] of logos) {
    if (bytes <= maxCachedBytes) {
      break;
    }
    logos.delete(oldest);
    bytes -= sizeOf(each);
  }
  logos.set(source, kept);
};

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  prefix.every((byte, index) => bytes[index] === byte);

/** The bytes of ASCII `text`. */
const ascii = (text: string): number[] => [...new TextEncoder().encode(text)];

/**
 * What may come before an SVG's root element, each by how it starts and
 * ends: an XML declaration, comments, a doctype.
 */
const svgPrologue = [
  ["<?xml", "?>"],
  ["<!--", "-->"],
  ["<!DOCTYPE", ">"],
] as const;

const svgRoot = /^<svg[\s>]/u;

/** The part of an SVG's prologue `text` has at `at`, if any. */
const prologuePartAt = (
  text: string,
  at: number
): (typeof svgPrologue)[number] | undefined =>
  svgPrologue.find(([start]) => text.startsWith(start, at));

/**
 * Whether `bytes` are an SVG document: UTF-8 (the decoder drops a
 * byte-order mark) whose root element is `svg`. Read part by part, not by
 * one pattern, so a crafted prologue costs no more than its length.
 */
const isSvg = (bytes: Uint8Array): boolean => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes
    );
  } catch {
    return false;
  }
  let at = 0;
  for (;;) {
    while (at < text.length && /\s/u.test(text.charAt(at))) {
      at += 1;
    }
    const part = prologuePartAt(text, at);
    if (part === undefined) {
      return svgRoot.test(text.slice(at, at + 5));
    }
    const [start, end] = part;
    const ends = text.indexOf(end, at + start.length);
    if (ends === -1) {
      return false;
    }
    at = ends + end.length;
  }
};

/** The image type `bytes` are, as their own signature says, if one we serve. */
export const logoTypeOf = (bytes: Uint8Array): CatalogLogoType | undefined => {
  if (startsWith(bytes, [0x89, ...ascii("PNG\r\n\u001A\n")])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (
    startsWith(bytes, ascii("GIF87a")) ||
    startsWith(bytes, ascii("GIF89a"))
  ) {
    return "image/gif";
  }
  if (
    startsWith(bytes, ascii("RIFF")) &&
    startsWith(bytes.subarray(8), ascii("WEBP"))
  ) {
    return "image/webp";
  }
  return isSvg(bytes) ? "image/svg+xml" : undefined;
};

/** A logo that didn't come: asked again next time, never kept. */
class LogoUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "LogoUnavailableError";
  }
}

/** Statuses that say nothing of the logo, only that it didn't come now. */
const isPassing = (status: number): boolean => status === 429 || status >= 500;

/**
 * The logo at `source`, or `null` when what Composio answers isn't one
 * connect serves. Throws {@link LogoUnavailableError} when it doesn't come.
 */
const fetchLogo = async (source: URL): Promise<CatalogLogo | null> => {
  let response: Response;
  try {
    response = await fetch(source, {
      headers: { accept: "image/*" },
      // A redirect could lead anywhere: never follow.
      redirect: "manual",
      signal: AbortSignal.timeout(logoTimeoutMs),
    });
  } catch (error) {
    throw new LogoUnavailableError("Composio's logo host didn't answer", error);
  }
  log.info("catalog.logo_fetched", { status: response.status });
  if (!response.ok) {
    // Never in place of the answer it gave.
    await response.body?.cancel().catch((error: unknown) => {
      log.warn("catalog.logo_cancel_failed", errorFields(error));
    });
    if (isPassing(response.status)) {
      throw new LogoUnavailableError(`Composio answered ${response.status}`);
    }
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = await readCappedBytes(response, maxLogoBytes);
  } catch (error) {
    // Too big, or no bytes: refused. The answer breaking off: it didn't come.
    if (!(error instanceof ComposioError)) {
      throw new LogoUnavailableError("Composio's logo broke off", error);
    }
    log.warn("catalog.logo_refused", errorFields(error));
    return null;
  }
  const contentType = logoTypeOf(bytes);
  if (contentType === undefined) {
    log.warn("catalog.logo_refused", { reason: "not_an_image" });
    return null;
  }
  return { contentType, bytes };
};

/** The logo at `source`, as kept while it is fresh. */
const cachedLogo = async (source: URL): Promise<CatalogLogo | null> => {
  const id = source.href;
  const hit = logos.get(id);
  if (hit !== undefined && hit.expiresAt > Date.now()) {
    return hit.logo;
  }
  const underWay = loading.get(id);
  if (underWay !== undefined) {
    return await underWay;
  }
  const loaded = (async () => {
    try {
      const logo = await fetchLogo(source);
      keep(id, logo);
      return logo;
    } finally {
      loading.delete(id);
    }
  })();
  loading.set(id, loaded);
  return await loaded;
};

/** One entry's logo, as `ConnectApi.catalogLogo` describes it. */
export const catalogLogo = async (
  env: Env,
  request: unknown
): Promise<CatalogLogo | null> => {
  const parsed = catalogLogoRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const { source, id } = parsed.data;
  const key = composioKey(env);
  // Native providers have no logo in the catalog; without a key, Composio's
  // toolkits aren't in it at all.
  if (source === "native" || key === undefined) {
    return null;
  }
  try {
    const listed = await listedToolkits(key);
    const logoSource = listed.find(({ entry }) => entry.id === id)?.logoSource;
    return logoSource === undefined ? null : await cachedLogo(logoSource);
  } catch (error) {
    if (
      !(error instanceof ComposioError || error instanceof LogoUnavailableError)
    ) {
      throw error;
    }
    log.warn("catalog.logo_unavailable", errorFields(error));
    return null;
  }
};
