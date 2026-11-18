import { asc, count, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { uploadCleanups, uploads } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";

// What is left of the files once uploaded into Knowledge, which is gone
// (GRA-1941): core's own rows of them (`uploads`) and their originals in
// `FILES` under `knowledge/`. Nothing uploads into Knowledge any more. A
// person's erasure forgets every upload they made (`eraseUploadsOf`): an
// original's delete is recorded (`upload_cleanups`) in the batch that
// forgets its upload, then done, every one due, page after page; an R2
// refusal fails the erasure's area, and its rerun deletes what is left.
// Nothing reads as erased before it is. The tables go with the account's
// deletion of the `knowledge/` originals.

/** Originals deleted at once: R2 deletes up to 1,000 keys in one call. */
export const cleanupsPerPage = 100;

/**
 * Deletes every original recorded for deleting whose upload is gone or
 * failed, a page at a time, clearing each page's records once R2 has
 * deleted them. Throws when R2 or the database refuses: the records stay,
 * for the run again.
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

/** How many uploads `userId` made into Knowledge that core still holds. */
export const uploadsOf = async (env: Env, userId: string): Promise<number> => {
  const [row] = await drizzle(env.DB)
    .select({ count: count() })
    .from(uploads)
    .where(eq(uploads.uploadedBy, userId));
  return row?.count ?? 0;
};

/**
 * Every upload `userId` made, wherever they uploaded it (GRA-1941): its
 * row, and its original, recorded for deleting in one batch, then every
 * original due deleted (`cleanUpOriginals`). Without Knowledge nothing
 * tells a collection only they read from one they shared, and what any of
 * them was uploaded into is gone, so none of theirs is kept. A person's
 * erasure calls it (person-erasure.ts, the `brain` area); it throws when
 * R2 or the database refuses, and the area runs it again.
 */
export const eraseUploadsOf = async (
  env: Env,
  userId: string
): Promise<void> => {
  const db = drizzle(env.DB);
  const where = eq(uploads.uploadedBy, userId);
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
