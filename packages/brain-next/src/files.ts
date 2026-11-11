import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { files } from "./db/schema.ts";

// The original files of source versions, in the host's Brain bucket (R2,
// in the EU: a bucket's jurisdiction is set when it's created). A file's
// key is the SHA-256 of its bytes, so the same content is one file
// however many versions hold it, and `files` counts how many do.
//
// R2 and the store share no transaction, so the order is what keeps them
// whole:
//
// 1. Before an add writes a file, its row is noted (`noteWrite`): new with
//    no versions counted, or touched, with when it was written. A file is
//    never in R2 without a row to find it by.
// 2. The file is written. Writing it again is harmless: same key, same
//    bytes.
// 3. The version, its chunks and words, its count on the file and the
//    source's current pointer are written in one transaction
//    (sources.ts). Only then is anything visible.
//
// A crash between 2 and 3 leaves a file nothing points at, and nothing
// visible. A retry of the add takes the same file and goes on. Otherwise
// the sweep (`sweepFiles`, on the host's clock) deletes it once it was
// written longer ago than an add takes (`fileGraceMs`). So does erasure
// (GRA-1729), for a file whose count it brings to 0: a file is deleted
// only with its row, while the store takes nothing else (the store's
// `blockConcurrencyWhile`), and only past the grace, so an add between 1
// and 3 never loses its file. An add that finds its row gone at 3 notes
// it again and fails, to be retried.

/** How long an add may take between noting a file and recording its version. */
export const fileGraceMs = 15 * 60 * 1000;

/** Files swept at once: as many as one statement can name. */
const sweepBatch = 100;

/**
 * How long a sweep waits for R2 to delete its batch: well under the time
 * workerd lets the store be held (`blockConcurrencyWhile`, about 30 s),
 * so a bucket that hangs never resets the store.
 */
export const sweepDeleteMs = 10_000;

/** The file of `hash`'s key in the bucket. */
export const fileKeyOf = (hash: string): string => `sources/${hash}`;

/** The SHA-256 of `bytes`, in hex. */
export const hashOf = async (bytes: Uint8Array): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
};

/** Whether the file of `hash` is in R2 and a version points at it. */
export const isHeld = (db: DrizzleSqliteDODatabase, hash: string): boolean => {
  const file = db
    .select({ refs: files.refs })
    .from(files)
    .where(eq(files.hash, hash))
    .get();
  return file !== undefined && file.refs > 0;
};

/**
 * Whether a delete of the file of `hash` may still land: a sweep gave up
 * waiting for R2 within the last `fileGraceMs` (`sweepFiles`).
 */
export const isInDoubt = (
  db: DrizzleSqliteDODatabase,
  hash: string
): boolean => {
  const file = db
    .select({ until: files.inDoubtUntil })
    .from(files)
    .where(eq(files.hash, hash))
    .get();
  const until = file?.until ?? null;
  return until !== null && until.getTime() > Date.now();
};

/** Notes that the file of `hash` is about to be written, now. */
export const noteWrite = (db: DrizzleSqliteDODatabase, hash: string): void => {
  const writtenAt = new Date();
  db.insert(files)
    .values({ hash, refs: 0, writtenAt })
    .onConflictDoUpdate({
      target: files.hash,
      set: { writtenAt, inDoubtUntil: null },
    })
    .run();
};

/**
 * Counts one more version pointing at the file of `hash`, in the
 * transaction that writes the version: false, counting nothing, when its
 * row is gone (swept since it was noted).
 */
export const holdFile = (db: DrizzleSqliteDODatabase, hash: string): boolean =>
  db
    .update(files)
    .set({ refs: sql`${files.refs} + 1` })
    .where(eq(files.hash, hash))
    .returning({ hash: files.hash })
    .get() !== undefined;

/**
 * Deletes `hashes`' files from R2, answering those it deleted: all at once,
 * or, when that fails, one by one, so a file R2 won't delete never holds
 * back the others.
 */
const deleteFiles = async (
  bucket: R2Bucket,
  hashes: readonly string[]
): Promise<string[]> => {
  try {
    await bucket.delete(hashes.map(fileKeyOf));
    return [...hashes];
  } catch {
    const results = await Promise.allSettled(
      hashes.map(async (hash) => {
        await bucket.delete(fileKeyOf(hash));
        return hash;
      })
    );
    return results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []
    );
  }
};

/**
 * Deletes the oldest batch of files no version points at that were noted
 * more than `fileGraceMs` before `at` (never later than now, so no caller's
 * clock shortens the grace): each from R2, then its row. A file R2 won't
 * delete is noted afresh, so it goes to the back and is tried again a
 * grace later, and never holds back the files behind it.
 *
 * Run it while the store takes nothing else (`blockConcurrencyWhile`).
 * What depends on that: between the R2 delete and the row delete, no add
 * may note the same file and write it (step 1 and 2), or the row delete
 * would then drop the row of a file just written, which nothing would
 * ever sweep. With the input blocked, an add notes the file only after
 * its row is gone, so it writes a new row and the file anew. Unverified:
 * that the continuation of an add's R2 call already in flight is held
 * back during `blockConcurrencyWhile` as a timer's is (it could not be
 * made to arrive mid-sweep in local workerd). The worst case needs an add
 * whose first step was more than `fileGraceMs` before its last.
 */
export const sweepFiles = async (
  db: DrizzleSqliteDODatabase,
  bucket: R2Bucket,
  at: Date
): Promise<"swept" | "idle" | "timed_out"> => {
  const asOf = Math.min(at.getTime(), Date.now());
  const unreferenced = and(
    eq(files.refs, 0),
    lte(files.writtenAt, new Date(asOf - fileGraceMs))
  );
  const due = db
    .select({ hash: files.hash })
    .from(files)
    .where(unreferenced)
    .orderBy(files.writtenAt)
    .limit(sweepBatch)
    .all()
    .map(({ hash }) => hash);
  if (due.length === 0) {
    return "idle";
  }
  // R2 that hangs: the batch is kept, as if R2 refused it, and tried again
  // a grace later. Its deletes may still land after this gave up, so each
  // file is in doubt for that grace: no add notes or writes it meanwhile
  // (sources.ts refuses, to be added again), or a late delete could take a
  // file a version holds. A delete that hasn't landed within the grace is
  // taken as never landing: an assumption, as nothing found bounds how
  // long R2 may carry out a delete its caller stopped waiting for. Past the
  // doubt the file is an ordinary leftover the next sweep deletes. The
  // unverified edge above, in this shape: the continuation of an add that
  // began before the sweep, if it ran during `blockConcurrencyWhile` (local
  // workerd can't make it), would freshen `written_at` (`noteWrite`), so
  // the timeout would not mark that row in doubt and a late delete could
  // land after that add's write; it rests on the same premise as before.
  const { promise: timedOut, resolve: giveUp } =
    Promise.withResolvers<"timed_out">();
  const timer = setTimeout(() => {
    giveUp("timed_out");
  }, sweepDeleteMs);
  const answered = await Promise.race([deleteFiles(bucket, due), timedOut]);
  clearTimeout(timer);
  const deleted = answered === "timed_out" ? [] : answered;
  if (deleted.length > 0) {
    db.delete(files)
      .where(and(unreferenced, inArray(files.hash, deleted)))
      .run();
  }
  const kept = due.filter((hash) => !deleted.includes(hash));
  if (kept.length > 0) {
    const now = Date.now();
    db.update(files)
      .set({
        writtenAt: new Date(now),
        ...(answered === "timed_out"
          ? { inDoubtUntil: new Date(now + fileGraceMs) }
          : {}),
      })
      .where(and(unreferenced, inArray(files.hash, kept)))
      .run();
  }
  return answered === "timed_out" ? "timed_out" : "swept";
};
