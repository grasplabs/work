import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { packageCleanups } from "../db/core/schema.ts";

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

/** Clears `key`'s record once a lock names what was written. */
export const clearCleanup = async (env: Env, key: string): Promise<void> => {
  await drizzle(env.DB)
    .delete(packageCleanups)
    .where(eq(packageCleanups.key, key));
};
