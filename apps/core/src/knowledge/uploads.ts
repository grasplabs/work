import type { ErasedFiles, OnErase } from "@grasp-os/brain/purge";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { uploadCleanups, uploads } from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";

// What is left of the files once uploaded into Knowledge: the uploads of
// the collections a person's erasure purges (`uploadErasure`), which it
// forgets, deleting their originals from R2, and those left unended,
// which the clock forgets (`sweepLeftUploads`). Nothing uploads into
// Knowledge any more: the purge forgets an upload whatever state it was
// left in. An original's delete is
// recorded (`upload_cleanups`) in the batch that forgets its upload, then
// done, every one due, page after page; an R2 refusal fails the purge's
// step, or the clock's run, and its rerun deletes what is left. Nothing
// reads as erased before it is.
//
// The clock forgets only an upload unchanged for `storingMs`: one the
// release before this one was still taking as it was replaced may yet
// store its original, and deleting its key first would leave that object
// with no row or record to delete it by. A recorded delete is due at once,
// for the purge and for the clock alike, so a purge's step ends with every
// original it recorded gone.

/**
 * How long after an upload last changed its original may still be being
 * stored, by a release still taking uploads: far more than storing 10 MB
 * takes.
 */
const storingMs = 10 * 60_000;

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

/**
 * Forgets the uploads of the collection `scope` and records their originals for deleting,
 * in one batch, then deletes every original due (`cleanUpOriginals`).
 */
const forgetUploads = async (env: Env, scope: ErasedFiles): Promise<void> => {
  const db = drizzle(env.DB);
  const where = eq(uploads.collectionId, scope.collectionId);
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

/**
 * Every minute (the clock), until the cutover removes Knowledge: forgets
 * the uploads that never ended and haven't changed for `storingMs`
 * (nothing finishes one any more), recording
 * their originals for deleting, then deletes every original due, those a
 * failure recorded before uploads stopped among them. Throws while R2 or
 * the database refuses: the clock records it and tries again.
 */
export const sweepLeftUploads = async (env: Env): Promise<void> => {
  const db = drizzle(env.DB);
  const unended = and(
    inArray(uploads.status, ["pending", "extracting", "saving"]),
    lt(uploads.updatedAt, new Date(Date.now() - storingMs))
  );
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
          .where(unended)
      )
      .onConflictDoNothing(),
    db.delete(uploads).where(unended),
  ]);
  await cleanUpOriginals(env);
};

/**
 * The uploads as a person's purge reaches them (purge.ts `OnErase`): the
 * originals of the files uploaded into the collections it purges hold the
 * data too, so it forgets the uploads and deletes their originals before
 * it deletes anything of the collections. Until the cutover's last step
 * removes Knowledge.
 */
export const uploadErasure = (env: Env): Pick<OnErase, "forgetFiles"> => ({
  forgetFiles: async (_person, scope) => {
    await forgetUploads(env, scope);
  },
});
