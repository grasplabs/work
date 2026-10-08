import { integritySchema } from "@grasp-os/shared/dependencies";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { dependencyBuildLeases, packageCleanups } from "../db/core/schema.ts";
import { deleteArtifact } from "./build.ts";
import { tarballKey } from "./tarballs.ts";

// Deleting, from the cron, the build leases that lapsed with nobody to
// take them again (`sweepBuildLeases`), and the package store's files no
// lock names any more: tarballs fetched for a resolve that failed or whose lock was
// deleted, artifacts a build wrote and never pinned, and artifacts whose
// pin or lock went. Each was recorded before it could be left behind
// (`package_cleanups`, cleanup-records.ts and locks.ts); this deletes its
// files only once no lock names it, then clears the record, so a cron
// that dies between the two deletes them again next time.
//
// A record is acted on only an hour after it was last recorded, so a
// resolve or build that just wrote a file has long pinned or stored it.
// One that writes the same file again as this runs records it again, and
// should this delete it all the same, nothing breaks: a tarball missing
// from the store is fetched again, and an artifact missing is built again,
// to its pin.

/** How long after it was last recorded a file may be deleted. */
const cleanupGraceMs = 60 * 60 * 1000;

/** Most records looked at in one run. */
const cleanupBatch = 50;

const artifactHashPattern = /^[0-9a-f]{64}$/u;

/** Deletes the files `key` names, if it names any. */
const deleteFiles = async (
  env: Env,
  kind: "tarball" | "build",
  key: string
): Promise<void> => {
  if (kind === "tarball") {
    if (integritySchema.safeParse(key).success) {
      await env.FILES.delete(tarballKey(key));
    }
    return;
  }
  if (artifactHashPattern.test(key)) {
    await deleteArtifact(env, key);
  }
};

/**
 * Which of `keys` some lock names now, as a tarball's integrity or a pin's
 * hash: one read over every lock's packages and pins for the whole run,
 * never one scan of every lock per record.
 */
const namedByLocks = async (
  env: Env,
  keys: readonly string[]
): Promise<ReadonlySet<string>> => {
  const wanted = JSON.stringify(keys);
  const { results } = await env.DB.prepare(
    `SELECT json_extract(p.value, '$.integrity') AS key FROM dependency_locks l, json_each(l.lock, '$.packages') p WHERE json_extract(p.value, '$.integrity') IN (SELECT value FROM json_each(?1))
     UNION
     SELECT json_extract(pin.value, '$.hash') AS key FROM dependency_locks l, json_each(l.lock, '$.artifacts') c, json_each(c.value) pin WHERE json_extract(pin.value, '$.hash') IN (SELECT value FROM json_each(?1))`
  )
    .bind(wanted)
    .all<{ key: string }>();
  return new Set(results.map(({ key }) => key));
};

/** Most lapsed build leases one run deletes. */
const leaseBatch = 100;

/**
 * Deletes, oldest first, build leases that lapsed: a build that died
 * holding one, of a graph nobody builds again, would otherwise leave it
 * for good (build.ts takes a lapsed lease again only for its own App,
 * graph and target). One statement, by the expiry's index: a lease taken
 * again as it runs no longer lapsed, and stays.
 */
const sweepBuildLeases = async (env: Env, now: Date): Promise<void> => {
  const db = drizzle(env.DB);
  const lapsed = db
    .select({ rowid: sql`rowid` })
    .from(dependencyBuildLeases)
    .where(lt(dependencyBuildLeases.expiresAt, now))
    .orderBy(asc(dependencyBuildLeases.expiresAt))
    .limit(leaseBatch);
  await db
    .delete(dependencyBuildLeases)
    .where(
      and(sql`rowid IN ${lapsed}`, lt(dependencyBuildLeases.expiresAt, now))
    );
};

/**
 * Deletes the files of records at least an hour old that no lock names,
 * and clears each record, a batch a run. A record recorded again while
 * this ran keeps its row for the next run. Never throws: a record that
 * fails is logged and moved to the back of the queue, so one that keeps
 * failing never holds up the rest.
 */
const sweepFiles = async (env: Env, now: Date): Promise<void> => {
  const db = drizzle(env.DB);
  try {
    const due = await db
      .select()
      .from(packageCleanups)
      .where(
        lt(packageCleanups.createdAt, new Date(now.getTime() - cleanupGraceMs))
      )
      .orderBy(asc(packageCleanups.createdAt))
      .limit(cleanupBatch);
    if (due.length === 0) {
      return;
    }
    const named = await namedByLocks(
      env,
      due.map(({ key }) => key)
    );
    for (const { key, kind, createdAt } of due) {
      try {
        if (!named.has(key)) {
          // oxlint-disable-next-line no-await-in-loop -- a few at a time
          await deleteFiles(env, kind, key);
        }
        // oxlint-disable-next-line no-await-in-loop -- a few at a time
        await db
          .delete(packageCleanups)
          .where(
            and(
              eq(packageCleanups.key, key),
              eq(packageCleanups.createdAt, createdAt)
            )
          );
      } catch (error) {
        log.error("packages.cleanup_failed", { kind, ...errorFields(error) });
        // oxlint-disable-next-line no-await-in-loop -- a few at a time
        await db
          .update(packageCleanups)
          .set({ createdAt: now })
          .where(
            and(
              eq(packageCleanups.key, key),
              eq(packageCleanups.createdAt, createdAt)
            )
          )
          .catch((pushError: unknown) => {
            log.error("packages.cleanup_failed", errorFields(pushError));
          });
      }
    }
  } catch (error) {
    log.error("packages.cleanup_failed", errorFields(error));
  }
};

/**
 * Deletes the build leases that lapsed (`sweepBuildLeases`), then the
 * files of records at least an hour old that no lock names (`sweepFiles`).
 * Never throws.
 */
export const sweepPackageFiles = async (env: Env, now: Date): Promise<void> => {
  try {
    await sweepBuildLeases(env, now);
  } catch (error) {
    log.error("packages.lease_sweep_failed", errorFields(error));
  }
  await sweepFiles(env, now);
};
