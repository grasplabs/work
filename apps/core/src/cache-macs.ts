import { fromBase64Url, toBase64Url } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";

import { derivedHmacKey } from "./derived-keys.ts";

// What core caches in R2 and later acts on (the manifests and triggers it
// registers) is held to what core wrote: each entry carries an HMAC under
// a key derived from core's secret, so whoever can write to the bucket but
// doesn't hold that secret can't have core take text of theirs as its own
// work. Each cache names its own purpose, so a MAC made for one never
// passes in another. Builds are held by their receipts instead
// (build-cache.ts).

/** What signing a cached entry reads from core's env. */
export type CacheMacEnv = Pick<Env, "BETTER_AUTH_SECRET">;

const encoder = new TextEncoder();

/** What an entry's MAC covers: its text under its key, never one alone. */
const signed = (cacheKey: string, text: string) =>
  encoder.encode(canonicalJson([cacheKey, text]));

/**
 * The MAC of `text` cached under `cacheKey` for `purpose`, to store in the
 * object's `mac` metadata: of the text under its key, so what core cached
 * for one key never passes as the entry of another.
 */
const cacheMac = async (
  env: CacheMacEnv,
  purpose: string,
  cacheKey: string,
  text: string
): Promise<string> => {
  const key = await derivedHmacKey(env, purpose, ["sign", "verify"]);
  return toBase64Url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, signed(cacheKey, text))
    )
  );
};

/**
 * Whether `text`, read from R2 under `cacheKey` as `object`, is what core
 * cached there for `purpose`: its `mac` metadata checks. One without a MAC,
 * or with one that doesn't check, is to be treated as not cached.
 */
const isCachedByCore = async (
  env: CacheMacEnv,
  purpose: string,
  cacheKey: string,
  text: string,
  object: Pick<R2Object, "customMetadata">
): Promise<boolean> => {
  const stated = object.customMetadata?.mac;
  if (stated === undefined) {
    return false;
  }
  let mac: Uint8Array<ArrayBuffer>;
  try {
    mac = fromBase64Url(stated);
  } catch {
    return false;
  }
  const key = await derivedHmacKey(env, purpose, ["sign", "verify"]);
  return await crypto.subtle.verify("HMAC", key, mac, signed(cacheKey, text));
};

/**
 * The text core cached in `bucket` under `cacheKey` for `purpose`, if its
 * MAC checks: undefined for a miss, and for anything core didn't write.
 */
export const readCached = async (
  env: CacheMacEnv,
  bucket: Pick<R2Bucket, "get">,
  purpose: string,
  cacheKey: string
): Promise<string | undefined> => {
  const object = await bucket.get(cacheKey);
  if (object === null) {
    return undefined;
  }
  const text = await object.text();
  return (await isCachedByCore(env, purpose, cacheKey, text, object))
    ? text
    : undefined;
};

/** Caches `text` in `bucket` under `cacheKey` for `purpose`, with its MAC. */
export const putCached = async (
  env: CacheMacEnv,
  bucket: Pick<R2Bucket, "put">,
  purpose: string,
  cacheKey: string,
  text: string
): Promise<void> => {
  await bucket.put(cacheKey, text, {
    customMetadata: { mac: await cacheMac(env, purpose, cacheKey, text) },
  });
};
