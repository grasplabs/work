import {
  compilerVersion,
  lintKey,
  lintRecordOf,
  moduleRecordOf,
} from "@grasp-os/compiler";
import type {
  Diagnostic,
  Increments,
  pageIncrementKeys,
} from "@grasp-os/compiler";
import {
  fromBase64Url,
  sha256Hex,
  toBase64Url,
} from "@grasp-os/shared/encoding";
import { errorFields, log } from "@grasp-os/shared/log";
import { mapConcurrently } from "@grasp-os/shared/release";

import { derivedHmacKey } from "./derived-keys.ts";

// What the toolchain makes of App code, kept in R2 (in the EU) under the
// hash of what it was made from and the toolchain's version: a whole
// build, an inspected manifest, a JSON workflow's expression check, one
// module's transform (the compiler's increments.ts) or one file's lint.
// The same input makes the same output, so whichever isolate makes an
// entry first keeps it, and any other making it meanwhile writes the same.
// A release with a new toolchain (`compilerVersion`: its kit, SDKs and
// policy) misses every entry, and each is made again the first time it
// is asked for.
//
// Cache poisoning (a stray or forged object, bytes cut short or rotted):
// each entry carries an HMAC of its key and text under a key derived from
// core's secret, so whoever can write to the bucket but doesn't hold that
// secret can't have core take text of theirs as its own work, nor move
// an entry to another key. One that fails its check is logged and taken
// for a miss: it is made again, and the new entry replaces it. Cached
// bytes grant nothing: an App's approved packages are kept here by their
// graph's hash, but every build checks the App's approval and the malware
// sources first, and is audited (packages/build.ts `buildPackages`); a
// workflow's reach it only as its version seals them
// (workflows/sealed-packages.ts).

/** Where every entry is kept: swept by age (pages.ts `sweepBuilds`). */
export const buildCachePrefix = "build-cache/";

/** The purpose its MACs are derived for (derived-keys.ts). */
const macPurpose = "build-cache";

/** What the cache reads and writes from core's env. */
export interface CacheEnv {
  BETTER_AUTH_SECRET: string;
  FILES: Pick<R2Bucket, "get" | "put">;
}

/**
 * The key of what `parts` make (its input, files as `inOrder` has them),
 * by the kind of entry it is (a `page-build`, a `lint`), under the
 * toolchain's version.
 */
export const cacheKeyOf = async (
  kind: string,
  parts: readonly unknown[]
): Promise<string> =>
  `${buildCachePrefix}${compilerVersion}/${kind}/${await sha256Hex(JSON.stringify(parts))}.json`;

/** `files` by path, in order: the same files are the same part of a key. */
export const inOrder = (
  files: Readonly<Record<string, string>>
): [string, string][] =>
  Object.entries(files).toSorted(([a], [b]) => (a < b ? -1 : 1));

const encoder = new TextEncoder();

/** What an entry's MAC covers: its text under its key, never one alone. */
const signed = (key: string, text: string) =>
  encoder.encode(JSON.stringify([key, text]));

const macOf = async (
  env: CacheEnv,
  key: string,
  text: string
): Promise<string> =>
  toBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await derivedHmacKey(env, macPurpose, ["sign", "verify"]),
        signed(key, text)
      )
    )
  );

const macHolds = async (
  env: CacheEnv,
  key: string,
  text: string,
  stated: string | undefined
): Promise<boolean> => {
  if (stated === undefined) {
    return false;
  }
  let mac: Uint8Array<ArrayBuffer>;
  try {
    mac = fromBase64Url(stated);
  } catch {
    return false;
  }
  return await crypto.subtle.verify(
    "HMAC",
    await derivedHmacKey(env, macPurpose, ["sign", "verify"]),
    mac,
    signed(key, text)
  );
};

/** Keeps `text` under `key`, with its MAC; logged, never thrown, when it can't. */
export const writeCache = async (
  env: CacheEnv,
  key: string,
  text: string
): Promise<void> => {
  try {
    await env.FILES.put(key, text, {
      customMetadata: { mac: await macOf(env, key, text) },
    });
  } catch (error) {
    // What it made stands: it is made again at its next use.
    log.warn("build.cache_write_failed", { key, ...errorFields(error) });
  }
};

/**
 * How old an entry may be when it is read before it is written again, so
 * one in use never ages into the sweep (pages.ts `buildKeepMs`): once a
 * week at most, whatever reads it.
 */
const refreshAfterMs = 7 * 24 * 60 * 60 * 1000;

/**
 * The text kept under `key`, if core kept it: undefined for a miss, for
 * an entry whose MAC doesn't hold (logged), and when R2 can't be read. An
 * entry read past {@link refreshAfterMs} is written again, its age reset.
 */
export const readCache = async (
  env: CacheEnv,
  key: string
): Promise<string | undefined> => {
  let object: R2ObjectBody | null;
  let text: string;
  try {
    object = await env.FILES.get(key);
    if (object === null) {
      return undefined;
    }
    text = await object.text();
  } catch (error) {
    log.warn("build.cache_read_failed", { key, ...errorFields(error) });
    return undefined;
  }
  if (!(await macHolds(env, key, text, object.customMetadata?.mac))) {
    // The alert: nothing but core writes there.
    log.error("build.cache_untrusted", { key });
    return undefined;
  }
  if (Date.now() - object.uploaded.getTime() > refreshAfterMs) {
    await writeCache(env, key, text);
  }
  return text;
};

/** How an entry came about, for its metrics. */
export type CacheOutcome = "hit" | "built";

/**
 * The entry under `key`: kept, or made by `make` and kept when it may be
 * (`cache`: false for what the load, not the input, decided).
 */
export const throughCache = async (
  env: CacheEnv,
  key: string,
  make: () => Promise<{ text: string; cache: boolean }>
): Promise<{ text: string; outcome: CacheOutcome }> => {
  const kept = await readCache(env, key);
  if (kept !== undefined) {
    return { text: kept, outcome: "hit" };
  }
  const made = await make();
  if (made.cache) {
    await writeCache(env, key, made.text);
  }
  return { text: made.text, outcome: "built" };
};

/** Most entries read or kept at once. */
const concurrency = 8;

/** The parsed entry under `key`, or nothing. */
const readJson = async (env: CacheEnv, key: string): Promise<unknown> => {
  const text = await readCache(env, key);
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
};

/**
 * The keys of what a pages build of some files may reuse and keep, by
 * path (`pageIncrementKeys`): the compiler's, which it checks again on
 * reuse.
 */
export type IncrementKeys = Awaited<ReturnType<typeof pageIncrementKeys>>;

/** Where the transform the compiler keys `key` is kept. */
const moduleCacheKey = async (key: string): Promise<string> =>
  await cacheKeyOf("module", [key]);

/**
 * What earlier builds kept of a pages build whose modules have `keys`:
 * each module's transform, by its key, shaped as a record of its own file.
 */
export const readModules = async (
  env: CacheEnv,
  keys: IncrementKeys
): Promise<Increments> => {
  const found: Increments = { modules: {} };
  await mapConcurrently(
    Object.entries(keys.modules),
    concurrency,
    async ([path, key]) => {
      const record = moduleRecordOf(
        await readJson(env, await moduleCacheKey(key)),
        path
      );
      if (record !== undefined) {
        found.modules[key] = record;
      }
    }
  );
  return found;
};

/**
 * Keeps what a pages build whose modules have `keys` transformed now
 * (`fresh`): only a record of one of its own files under the key `keys`
 * gives it, so nothing is kept under a key it doesn't stand for.
 */
export const keepModules = async (
  env: CacheEnv,
  keys: IncrementKeys,
  fresh: Increments
): Promise<number> => {
  const kept = Object.entries(fresh.modules).filter(
    ([key, record]) =>
      keys.modules[record.path] === key &&
      moduleRecordOf(record, record.path) !== undefined
  );
  await mapConcurrently(kept, concurrency, async ([key, record]) => {
    await writeCache(env, await moduleCacheKey(key), JSON.stringify(record));
  });
  return kept.length;
};

/** Where the lint of `path` (`source`) is kept (`lintKey`). */
const lintCacheKey = async (path: string, source: string): Promise<string> =>
  await cacheKeyOf("lint", [await lintKey(path, source)]);

/**
 * What earlier lints found in each of `files` (by path) whose result is
 * kept under the key of its content: the rest are linted again.
 */
export const readLints = async (
  env: CacheEnv,
  files: Readonly<Record<string, string>>
): Promise<Record<string, Diagnostic[]>> => {
  const found: Record<string, Diagnostic[]> = {};
  await mapConcurrently(
    Object.entries(files),
    concurrency,
    async ([path, source]) => {
      const record = lintRecordOf(
        await readJson(env, await lintCacheKey(path, source)),
        path
      );
      if (record !== undefined) {
        found[path] = record.diagnostics;
      }
    }
  );
  return found;
};

/** Keeps what the lint found in each of `files` (`linted`, by path). */
export const keepLints = async (
  env: CacheEnv,
  files: Readonly<Record<string, string>>,
  linted: Readonly<Record<string, Diagnostic[]>>
): Promise<void> => {
  await mapConcurrently(
    Object.entries(linted),
    concurrency,
    async ([path, diagnostics]) => {
      const source = files[path];
      if (source !== undefined) {
        await writeCache(
          env,
          await lintCacheKey(path, source),
          JSON.stringify({ path, diagnostics })
        );
      }
    }
  );
};
