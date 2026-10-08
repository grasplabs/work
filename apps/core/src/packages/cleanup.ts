import { integritySchema } from "@grasp-os/shared/dependencies";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { dependencyLocks, packageCleanups } from "../db/core/schema.ts";
import { deleteArtifact } from "./build.ts";
import { tarballKey } from "./tarballs.ts";

// Deleting the package store's files no lock names any more, from the
// cron: tarballs fetched for a resolve that failed or whose lock was
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
 * Deletes the files of records at least an hour old that no lock names,
 * and clears each record, a batch a run. A record recorded again while
 * this ran keeps its row for the next run. Never throws: a record that
 * fails is logged and tried again next time.
 */
export const sweepPackageFiles = async (env: Env, now: Date): Promise<void> => {
  const db = drizzle(env.DB);
  const due = await db
    .select()
    .from(packageCleanups)
    .where(
      lt(packageCleanups.createdAt, new Date(now.getTime() - cleanupGraceMs))
    )
    .orderBy(asc(packageCleanups.createdAt))
    .limit(cleanupBatch);
  for (const { key, kind, createdAt } of due) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a few at a time
      const named = await db
        .select({ named: sql<number>`1` })
        .from(dependencyLocks)
        .where(sql`instr(${dependencyLocks.lock}, ${key}) > 0`)
        .limit(1)
        .get();
      if (named === undefined) {
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
    }
  }
};
