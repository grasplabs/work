import type { ErasedFiles, OnErase } from "@grasp-os/brain/purge";
import { and, asc, count, eq, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { uploadCleanups, uploads } from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";

// What is left of the files once uploaded into Knowledge: the uploads a
// Knowledge purge reaches (`uploadErasure`), which it forgets, deleting
// their originals from R2. Nothing uploads into Knowledge any more, so
// nothing is still storing an original or saving an upload's text: the
// purge forgets an upload whatever state it was left in. An original's
// delete is recorded (`upload_cleanups`) in the batch that forgets its
// upload, then done before the purge's step ends: every one due, page
// after page, and an R2 refusal fails the step, so the purge is run again
// and its rerun deletes what is left. Nothing reads as erased before it is.

/** Originals deleted at once: R2 deletes up to 1,000 keys in one call. */
export const cleanupsPerPage = 100;

/**
 * Deletes every original recorded for deleting whose upload is gone or
 * failed, a page at a time, clearing each page's records once R2 has
 * deleted them. Throws when R2 or the database refuses: the records stay,
 * for the purge run again.
 */
const cleanUpOriginals = async (env: Env): Promise<void> => {
  const db = drizzle(env.DB);
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- page after page, until none is left
    const page = await db
      .select({ key: uploadCleanups.key })
      .from(uploadCleanups)
      .where(
        sql`NOT EXISTS (SELECT 1 FROM ${uploads} WHERE ${uploads.id} = ${uploadCleanups.uploadId} AND ${uploads.status} != 'failed')`
      )
      .orderBy(asc(uploadCleanups.key))
      .limit(cleanupsPerPage);
    if (page.length === 0) {
      return;
    }
    const keys = page.map(({ key }) => key);
    // oxlint-disable-next-line no-await-in-loop -- the page's records go once R2 deleted it
    await env.FILES.delete(keys);
    // oxlint-disable-next-line no-await-in-loop -- before the next page is read
    await db.delete(uploadCleanups).where(inList(uploadCleanups.key, keys));
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
 * in one batch, then deletes every original due (`cleanUpOriginals`).
 */
const forgetUploads = async (env: Env, scope: ErasedFiles): Promise<void> => {
  const db = drizzle(env.DB);
  const where = uploadsOf(scope);
  await db.batch([
    db
      .insert(uploadCleanups)
      .select(
        db
          .select({
            key: sql<string>`'knowledge/' || ${uploads.collectionId} || '/' || ${uploads.id}`.as(
              "key"
            ),
            uploadId: uploads.id,
            createdAt: uploads.createdAt,
          })
          .from(uploads)
          .where(where)
      )
      .onConflictDoNothing(),
    db.delete(uploads).where(where),
  ]);
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
