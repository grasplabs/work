import {
  checkRecordOf,
  compilerVersion,
  incrementSchema,
  lintKey,
  lintRecordOf,
  moduleRecordOf,
} from "@grasp-os/compiler";
import type {
  CheckRecord,
  Diagnostic,
  Increments,
  pageIncrementKeys,
} from "@grasp-os/compiler";
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

// What a pages build keeps of each file for the next (GRA-958): each
// module's transform (the compiler's increments.ts); each file's
// Ultracite lint, which a draft's lint build keeps (save-builds.ts); and,
// for an App too large to type-check in one run, what each file's check
// said (the compiler's check-plan.ts, pages.ts `typeChecked`), kept
// together, one object per App and target, so a build reads and writes
// them in a handful of calls. They are kept as whole builds are
// (build-cache.ts): in R2, each served only as its receipt says its build
// wrote it, written by one build at a time under the key's lease,
// quarantined after repeated integrity failures, swept like builds once
// unused (pages.ts `sweepBuilds`). The compiler uses one only under the
// key it works out itself; here they are only fetched and kept.

/** Where each part's records are kept: swept with the builds. */
export const incrementPrefixes = {
  modules: "page-modules/",
  lints: "lint-results/",
} as const;

/**
 * Where each App's type checks are kept: swept with the builds, apart
 * from `incrementPrefixes` as the sweep lists it last (pages.ts).
 */
export const checksPrefix = "type-checks/";

const prefixes = { ...incrementPrefixes, checks: checksPrefix } as const;

type Part = keyof typeof prefixes;

/** The cache key of a record of `part` under its content key. */
const cacheKeyOf = (part: Part, key: string): string =>
  `${prefixes[part]}${keySchema}/${incrementSchema}/${compilerVersion}/${key}.json`;

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
 * The keys of what a pages build may reuse and keep, by path
 * (`pageIncrementKeys`): worked out once per build, as they hash every
 * file, and handed to each read and write of its records.
 */
export type IncrementKeys = Awaited<ReturnType<typeof pageIncrementKeys>>;

/**
 * What earlier builds kept that a pages build whose records have `keys`
 * may reuse, as records by content key: each one its receipt vouches for
 * and shaped as a record of its own file. One written longer ago than
 * `refreshAfterMs` is written again, as a build in use is.
 */
export const readIncrements = async (
  env: CacheEnv,
  keys: IncrementKeys,
  refreshAfterMs: number
): Promise<Increments> => {
  const found: Increments = { modules: {} };
  await mapConcurrently(
    Object.entries(keys.modules),
    concurrency,
    async ([path, key]) => {
      const record = moduleRecordOf(
        await readRecord(env, "modules", key, refreshAfterMs),
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
 * Keeps what a pages build whose records have `keys` made now
 * (`fresh`), each under its key's lease, held for `leaseMs`: only a record
 * of one of the build's own files under the key `keys` gives it, so
 * nothing is kept under a key it doesn't stand for. How many were kept.
 */
export const keepIncrements = async (
  env: CacheEnv,
  keys: IncrementKeys,
  fresh: Increments,
  leaseMs: number
): Promise<number> => {
  const toKeep = Object.entries(fresh.modules).flatMap(([key, record]) =>
    keys.modules[record.path] === key &&
    moduleRecordOf(record, record.path) !== undefined
      ? [["modules", key, JSON.stringify(record)] as const]
      : []
  );
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

/**
 * What earlier lints found in each of `files` (by path), for those whose
 * result is kept under the key of their content and, for a page or a
 * component, of the App's others (`designContext`, `lintKey`): the rest
 * are linted again.
 */
export const readLints = async (
  env: CacheEnv,
  files: Readonly<Record<string, string>>,
  designContext: string,
  refreshAfterMs: number
): Promise<Record<string, Diagnostic[]>> => {
  const found: Record<string, Diagnostic[]> = {};
  await mapConcurrently(
    Object.entries(files),
    concurrency,
    async ([path, source]) => {
      const key = await lintKey(path, source, designContext);
      const record = lintRecordOf(
        await readRecord(env, "lints", key, refreshAfterMs),
        path
      );
      if (record !== undefined) {
        found[path] = record.diagnostics;
      }
    }
  );
  return found;
};

/**
 * Keeps what Ultracite's lint found in each of `files` (`linted`, by
 * path), under the key `readLints` reads it by, held for `leaseMs`. Never
 * throws: a result not kept is linted again next time.
 */
export const keepLints = async (
  env: CacheEnv,
  files: Readonly<Record<string, string>>,
  designContext: string,
  linted: Readonly<Record<string, Diagnostic[]>>,
  leaseMs: number
): Promise<void> => {
  await mapConcurrently(
    Object.entries(linted),
    concurrency,
    async ([path, diagnostics]) => {
      const source = files[path];
      if (source === undefined) {
        return;
      }
      try {
        await keepUnderLease(
          env,
          cacheKeyOf("lints", await lintKey(path, source, designContext)),
          JSON.stringify({ path, diagnostics }),
          leaseMs
        );
      } catch (error) {
        log.warn("build.lint_keep_failed", errorFields(error));
      }
    }
  );
};

/**
 * What an App's earlier checks of one target (`set`, its key: pages.ts
 * `typeChecked`) said of each file, by the file's key (the compiler's
 * `checkKeys`): one read. A record is used only under the key it is kept
 * by, and only for its own file, where it is read (pages.ts).
 */
export const readChecks = async (
  env: CacheEnv,
  set: string,
  refreshAfterMs: number
): Promise<Map<string, CheckRecord>> => {
  const kept = await readRecord(env, "checks", set, refreshAfterMs);
  const found = new Map<string, CheckRecord>();
  if (typeof kept !== "object" || kept === null) {
    return found;
  }
  const entries: [string, unknown][] = Object.entries(kept);
  for (const [key, value] of entries) {
    const record =
      typeof value === "object" &&
      value !== null &&
      "path" in value &&
      typeof value.path === "string"
        ? checkRecordOf(value, value.path)
        : undefined;
    if (record !== undefined) {
      found.set(key, record);
    }
  }
  return found;
};

/**
 * Keeps what an App's check of one target (`set`) said of each file, by
 * the file's key (`records`), in place of what was kept before: one
 * write, held for `leaseMs`. Never throws: a check not kept is done again
 * next time.
 */
export const keepChecks = async (
  env: CacheEnv,
  set: string,
  records: ReadonlyMap<string, CheckRecord>,
  leaseMs: number
): Promise<void> => {
  try {
    await keepUnderLease(
      env,
      cacheKeyOf("checks", set),
      JSON.stringify(Object.fromEntries(records)),
      leaseMs
    );
  } catch (error) {
    log.warn("build.check_keep_failed", errorFields(error));
  }
};
