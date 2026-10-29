import {
  checkRecordOf,
  compilerVersion,
  incrementSchema,
  moduleRecordOf,
  screenIncrementKeys,
} from "@grasp-os/compiler";
import type { Increments } from "@grasp-os/compiler";
import { errorFields, log } from "@grasp-os/shared/log";
import { mapConcurrently } from "@grasp-os/shared/release";

import {
  keepUnderLease,
  keySchema,
  lastUsedOf,
  readVerified,
  refreshKept,
  usedNow,
} from "./build-cache.ts";
import type { CacheEnv } from "./build-cache.ts";

// What a screens build keeps of each file for the next (GRA-958): each
// module's transform and each file's type check (the compiler's
// increments.ts). They are kept as whole builds are (build-cache.ts): in
// R2 under a key of their content, each served only as its receipt says
// its build wrote it, written by one build at a time under the key's
// lease, quarantined after repeated integrity failures, swept like builds
// once unused (screens.ts `sweepBuilds`). The compiler uses one only
// under the key it works out itself; here they are only fetched and kept.

/** Where each part's records are kept: swept with the builds. */
export const incrementPrefixes = {
  modules: "screen-modules/",
  checks: "screen-checks/",
} as const;

type Part = keyof typeof incrementPrefixes;

/** The cache key of a record of `part` under its content key. */
const cacheKeyOf = (part: Part, key: string): string =>
  `${incrementPrefixes[part]}${keySchema}/${incrementSchema}/${compilerVersion}/${key}.json`;

/** Most records read or kept at once. */
const concurrency = 8;

/** What reading one record found: it, or nothing (a miss, or bytes no receipt vouches for). */
const readRecord = async (
  env: CacheEnv,
  part: Part,
  key: string,
  refreshAfterMs: number
): Promise<unknown> => {
  const cacheKey = cacheKeyOf(part, key);
  let read: Awaited<ReturnType<typeof readVerified>>;
  try {
    read = await readVerified(env, cacheKey);
  } catch (error) {
    // Nothing vouches for it: the build makes it again.
    log.warn("build.increment_read_failed", errorFields(error));
    return undefined;
  }
  if (read.state !== "hit") {
    return undefined;
  }
  if (Date.now() - lastUsedOf(read.object) > refreshAfterMs) {
    try {
      await refreshKept(env, cacheKey, read.objectKey, read.text, usedNow());
    } catch (error) {
      // Read all the same: it's written again at its next use.
      log.warn("build.refresh_failed", errorFields(error));
    }
  }
  try {
    const parsed: unknown = JSON.parse(read.text);
    return parsed;
  } catch {
    return undefined;
  }
};

/**
 * What earlier builds kept that a screens build of `files` may reuse,
 * as records by content key: each one its receipt vouches for and shaped
 * as a record of its own file. One written longer ago than
 * `refreshAfterMs` is written again, as a build in use is.
 */
export const readIncrements = async (
  env: CacheEnv,
  files: Readonly<Record<string, string>>,
  preview: boolean,
  refreshAfterMs: number
): Promise<Increments> => {
  const keys = await screenIncrementKeys(files, preview);
  const found: Increments = { modules: {}, checks: {} };
  const wanted = [
    ...Object.entries(keys.modules).map(
      ([path, key]) => ["modules", path, key] as const
    ),
    ...Object.entries(keys.checks).map(
      ([path, key]) => ["checks", path, key] as const
    ),
  ];
  await mapConcurrently(wanted, concurrency, async ([part, path, key]) => {
    const value = await readRecord(env, part, key, refreshAfterMs);
    if (part === "modules") {
      const record = moduleRecordOf(value, path);
      if (record !== undefined) {
        found.modules[key] = record;
      }
    } else {
      const record = checkRecordOf(value, path);
      if (record !== undefined) {
        found.checks[key] = record;
      }
    }
  });
  return found;
};

/**
 * Keeps what a screens build of `files` made now (`fresh`), each under
 * its key's lease, held for `leaseMs`: only a record of one of the build's
 * own files under the key `files` gives it, so nothing is kept under a
 * key it doesn't stand for. How many were kept.
 */
export const keepIncrements = async (
  env: CacheEnv,
  files: Readonly<Record<string, string>>,
  preview: boolean,
  fresh: Increments,
  leaseMs: number
): Promise<number> => {
  const keys = await screenIncrementKeys(files, preview);
  const toKeep = [
    ...Object.entries(fresh.modules).flatMap(([key, record]) =>
      keys.modules[record.path] === key &&
      moduleRecordOf(record, record.path) !== undefined
        ? [["modules", key, JSON.stringify(record)] as const]
        : []
    ),
    ...Object.entries(fresh.checks).flatMap(([key, record]) =>
      keys.checks[record.path] === key &&
      checkRecordOf(record, record.path) !== undefined
        ? [["checks", key, JSON.stringify(record)] as const]
        : []
    ),
  ];
  const kept = await mapConcurrently(
    toKeep,
    concurrency,
    async ([part, key, text]) => {
      try {
        return await keepUnderLease(env, cacheKeyOf(part, key), text, leaseMs);
      } catch (error) {
        // The build stands without it: the next one makes it again.
        log.warn("build.increment_keep_failed", errorFields(error));
        return false;
      }
    }
  );
  return kept.filter(Boolean).length;
};
