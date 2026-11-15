import type { ErasedFiles, OnErase } from "@grasp-os/brain/purge";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, asc, count, eq, lt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { uploadCleanups, uploads } from "../db/core/schema.ts";

// What is left of the files once uploaded into Knowledge: the uploads a
// Knowledge purge reaches (`uploadErasure`), which it forgets, deleting
// their originals from R2. Nothing uploads into Knowledge any more. An
// original's delete is recorded (`upload_cleanups`) in the batch that
// forgets its upload, then done at once; an upload that never ended may
// still have been storing it when it was recorded, and its delete waits
// until it can't be, when the next purge's cleanup does it.

/**
 * How long after an upload is recorded its original may still be being
 * stored: far more than storing 10 MB and starting a run take.
 */
const storingMs = 10 * 60_000;

/** Deletes the original at `key` from R2, then clears its cleanup. */
const cleanUp = async (
  env: Env,
  db: DrizzleD1Database,
  key: string
): Promise<void> => {
  await env.FILES.delete(key);
  await db.delete(uploadCleanups).where(eq(uploadCleanups.key, key));
};

/** Most cleanups looked at at once. */
const sweepBatch = 20;

/**
 * Deletes the originals recorded for deleting whose upload is gone or
 * failed, and that nothing can still be storing, a few at a time, and
 * clears each once done. Never throws: whoever recorded them has committed
 * already, and the next purge's cleanup deletes what's left.
 */
const cleanUpOriginals = async (env: Env): Promise<void> => {
  const db = drizzle(env.DB);
  try {
    const cleanups = await db
      .select({ key: uploadCleanups.key })
      .from(uploadCleanups)
      .where(
        and(
          lt(uploadCleanups.createdAt, new Date(Date.now() - storingMs)),
          sql`NOT EXISTS (SELECT 1 FROM ${uploads} WHERE ${uploads.id} = ${uploadCleanups.uploadId} AND ${uploads.status} != 'failed')`
        )
      )
      .orderBy(asc(uploadCleanups.createdAt))
      .limit(sweepBatch);
    for (const { key } of cleanups) {
      // oxlint-disable-next-line no-await-in-loop -- a few at a time
      await cleanUp(env, db, key);
    }
  } catch (error) {
    log.error("upload.cleanup_failed", errorFields(error));
  }
};

/** The uploads of `scope`: a collection's, or those under a document's name. */
const uploadsOf = (scope: ErasedFiles): SQL =>
  ("path" in scope
    ? and(
        eq(uploads.collectionId, scope.collectionId),
        eq(uploads.path, scope.path)
      )
    : eq(uploads.collectionId, scope.collectionId)) ?? sql`0`;

/**
 * Forgets the uploads of `scope` and records their originals for deleting,
 * then deletes what it can: one batch, which fails while one of them is
 * claimed for its save (`saving`), as `knowledge.conflict`: running the
 * purge again a moment later forgets it, or finds its text saved.
 */
const forgetUploads = async (env: Env, scope: ErasedFiles): Promise<void> => {
  const db = drizzle(env.DB);
  const where = uploadsOf(scope);
  const saving = and(where, eq(uploads.status, "saving"));
  try {
    await db.batch([
      // Fails the batch while one is being saved: it inserts a cleanup
      // without a key, which NOT NULL refuses; D1 has no other way to
      // abort a batch on a condition.
      db
        .insert(uploadCleanups)
        .select(
          sql`SELECT NULL, NULL, NULL WHERE EXISTS (SELECT 1 FROM ${uploads} WHERE ${saving})`
        ),
      db
        .insert(uploadCleanups)
        .select(
          db
            .select({
              key: sql<string>`'knowledge/' || ${uploads.collectionId} || '/' || ${uploads.id}`.as(
                "key"
              ),
              uploadId: uploads.id,
              // One that ended has its original written: deleted at once.
              // One still pending may still be storing it: its cleanup
              // waits until it can't be.
              createdAt:
                sql<Date>`CASE WHEN ${uploads.status} IN ('ready', 'failed') THEN 0 ELSE ${uploads.createdAt} END`.as(
                  "created_at"
                ),
            })
            .from(uploads)
            .where(where)
        )
        .onConflictDoNothing(),
      db.delete(uploads).where(where),
    ]);
  } catch (error) {
    const stillSaving = await db
      .select({ id: uploads.id })
      .from(uploads)
      .where(saving)
      .get();
    if (stillSaving !== undefined) {
      throw knowledgeErrors.create("knowledge.conflict");
    }
    throw error;
  }
  await cleanUpOriginals(env);
};

/** Scopes one count of a purge's uploads names (`uploadErasure`). */
const scopesPerCount = 40;

/**
 * The uploads as a Knowledge purge reaches them (purge.ts `OnErase`): the
 * originals of the files uploaded as the documents it purges hold the data
 * too, so it forgets the uploads and deletes their originals.
 */
export const uploadErasure = (
  env: Env
): Pick<OnErase, "countFiles" | "forgetFiles"> => ({
  countFiles: async (scopes) => {
    let total = 0;
    // D1 binds at most 100 values a statement: two a scope.
    for (let at = 0; at < scopes.length; at += scopesPerCount) {
      // oxlint-disable-next-line no-await-in-loop -- one bounded count after another
      const [found] = await drizzle(env.DB)
        .select({ count: count() })
        .from(uploads)
        .where(or(...scopes.slice(at, at + scopesPerCount).map(uploadsOf)));
      total += found?.count ?? 0;
    }
    return total;
  },
  forgetFiles: async (_person, scope) => {
    await forgetUploads(env, scope);
  },
});
