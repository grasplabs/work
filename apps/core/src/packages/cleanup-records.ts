import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { dependencyLocks, packageCleanups } from "../db/core/schema.ts";

// Recording files of the package store for cleanup before they could be
// left behind (cleanup.ts deletes them): the intent first, then the write,
// then the record cleared once something names what was written.

/**
 * Records `key` (a tarball's integrity, or an artifact's hash) for
 * cleanup, before its files are written; recording it again moves its
 * time on, so the cron gives a write under way its full hour.
 */
export const recordCleanup = async (
  env: Env,
  kind: "tarball" | "build",
  key: string
): Promise<void> => {
  const now = new Date();
  await drizzle(env.DB)
    .insert(packageCleanups)
    .values({ key, kind, createdAt: now })
    .onConflictDoUpdate({
      target: packageCleanups.key,
      set: { createdAt: sql`excluded.created_at` },
    });
};

/**
 * Clears the record of artifact `hash` once `app`'s lock of `graphHash`
 * pins it, and only while it does, in one statement: a resolve that takes
 * the lock's room records the artifact again as it deletes the lock
 * (locks.ts), and that record must stand, before or after this runs.
 */
export const clearBuildCleanup = async (
  env: Env,
  { app, graphHash, hash }: { app: string; graphHash: string; hash: string }
): Promise<void> => {
  await drizzle(env.DB)
    .delete(packageCleanups)
    .where(
      and(
        eq(packageCleanups.key, hash),
        sql`EXISTS (SELECT 1 FROM ${dependencyLocks} l, json_each(l.lock, '$.artifacts') c, json_each(c.value) pin WHERE l.app_id = ${app} AND l.graph_hash = ${graphHash} AND json_extract(pin.value, '$.hash') = ${hash})`
      )
    );
};

/**
 * Moves `key`'s record on, if it has one, as its file is read: what is in
 * use gets its full hour again before the cron may delete it.
 */
export const touchCleanup = async (env: Env, key: string): Promise<void> => {
  await drizzle(env.DB)
    .update(packageCleanups)
    .set({ createdAt: new Date() })
    .where(eq(packageCleanups.key, key));
};
