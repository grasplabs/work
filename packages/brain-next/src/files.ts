import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import type { BrainBucket } from "./bucket.ts";
import { fileGraceMs } from "./contract.ts";
import { files, vectorFiles } from "./db/schema.ts";

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
//
// The full vectors of passages (embedding.ts) are kept the same way, by
// their model and their text's SHA-256 (`vectorFiles`), and swept by the
// same sweep, past the same grace and doubt: a row is noted before its
// object is written (`noteVectorWrite`), and an object is deleted only
// with its row, once no current chunk holds its text, or its model is no
// longer the host's. Rows that may be such are marked `unheld` (as a
// version is replaced or erased, as a run writes, as a build is
// replaced), and the sweep checks each again before it deletes, so one
// that is held again is kept. A run whose write races the sweep is safe
// as an add is: a row noted within the grace is never swept, and a row in
// doubt is never written. When ticks overlap, a sweep can delete an
// object a run has just written again: its row stays, held, the object is
// gone, and the next run that needs that text runs the model again. No
// wrong data, only a model call.

/** Files swept at once: as many as one statement can name. */
const sweepBatch = 100;

/**
 * How long a sweep waits for R2 to delete its batch: well under the time
 * workerd lets the store be held (`blockConcurrencyWhile`, about 30 s),
 * so a bucket that hangs never resets the store.
 */
export const sweepDeleteMs = 10_000;

/** Vector objects swept at once: with a batch of files, one R2 call. */
const vectorSweepBatch = 400;

/** Where versions' files are kept in the store's part of the bucket. */
export const filesPrefix = "sources/";

/** Where vectors are kept in the store's part of the bucket. */
export const vectorsPrefix = "vectors/";

/** The file of `hash`'s key in the bucket. */
export const fileKeyOf = (hash: string): string => `${filesPrefix}${hash}`;

/** Where `model`'s vectors are kept in the bucket. */
export const vectorPrefixOf = (model: string): string =>
  `${vectorsPrefix}${encodeURIComponent(model)}/`;

/** The key of the vector of a passage of `hash` by `model`. */
export const vectorKeyOf = (model: string, hash: string): string =>
  `${vectorPrefixOf(model)}${hash}`;

/** A vector object, as its row names it. */
export interface VectorObject {
  model: string;
  hash: string;
}

/**
 * Notes that the vector of `hash` by `model` is about to be written, now,
 * unless a delete of it may still land: false then, and it must not be
 * written. A row new to the store is unheld until the run that wrote it
 * says otherwise (`settleVectorWrites`).
 */
export const noteVectorWrite = (
  db: DrizzleSqliteDODatabase,
  { model, hash }: VectorObject
): boolean => {
  const kept = db
    .select({ until: vectorFiles.inDoubtUntil })
    .from(vectorFiles)
    .where(and(eq(vectorFiles.model, model), eq(vectorFiles.hash, hash)))
    .get();
  const until = kept?.until ?? null;
  if (until !== null && until.getTime() > Date.now()) {
    return false;
  }
  const writtenAt = new Date();
  db.insert(vectorFiles)
    .values({ model, hash, writtenAt, unheld: true })
    .onConflictDoUpdate({
      target: [vectorFiles.model, vectorFiles.hash],
      set: { writtenAt, inDoubtUntil: null },
    })
    .run();
  return true;
};

/**
 * Of `hashes`, those whose vector by `model` a delete may still land on:
 * a sweep gave up waiting for R2 within the grace. Such an object is
 * neither read nor written meanwhile: what it holds may be gone any time.
 */
export const vectorsInDoubt = (
  store: SqlStorage,
  model: string,
  hashes: readonly string[]
): Set<string> =>
  new Set(
    store
      .exec<{ hash: string }>(
        `SELECT hash FROM vector_files
        WHERE model = ? AND in_doubt_until > ?
          AND hash IN (SELECT value FROM json_each(?))`,
        model,
        Date.now(),
        JSON.stringify(hashes)
      )
      .toArray()
      .map(({ hash }) => hash)
  );

/**
 * A write of `object` the run stopped waiting for, which may still land:
 * its row stays, unheld, its grace from now, so the sweep deletes it only
 * after the write would have landed (a write that hasn't within the grace
 * is taken as never landing, as a delete is).
 */
export const leftVectorWrite = (
  store: SqlStorage,
  { model, hash }: VectorObject
): void => {
  store.exec(
    "UPDATE vector_files SET written_at = ?, unheld = 1 WHERE model = ? AND hash = ?",
    Date.now(),
    model,
    hash
  );
};

/**
 * After a run wrote the vectors of `rows`: each is held while a current
 * chunk holds its text, and otherwise left for the sweep. Run it in the
 * transaction that writes their codes.
 */
export const settleVectorWrites = (
  store: SqlStorage,
  rows: readonly VectorObject[]
): void => {
  store.exec(
    `UPDATE vector_files SET unheld = NOT EXISTS (
      SELECT 1 FROM chunks
      JOIN current_versions ON current_versions.version_row = chunks.version_row
      WHERE chunks.hash = vector_files.hash)
    WHERE (model, hash) IN (
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]')
      FROM json_each(?))`,
    JSON.stringify(rows.map(({ model, hash }) => [model, hash]))
  );
};

/**
 * Lets go of what is kept of the texts of `hashes` (JSON), in every
 * model, once they may have left the current chunks: their vectors are
 * marked for the sweep to check, and the passages a model couldn't embed
 * are forgotten where no current chunk holds that text any more. Run it in
 * the transaction that makes a version no longer current, or erases it,
 * after its chunks are gone or no longer current: one rule for both.
 */
export const releaseVectors = (store: SqlStorage, hashes: string): void => {
  store.exec(
    `UPDATE vector_files SET unheld = 1
    WHERE unheld = 0 AND hash IN (SELECT value FROM json_each(?))`,
    hashes
  );
  store.exec(
    `DELETE FROM unembeddable
    WHERE hash IN (SELECT value FROM json_each(?1))
      AND NOT EXISTS (
        SELECT 1 FROM chunks
        JOIN current_versions ON current_versions.version_row = chunks.version_row
        WHERE chunks.hash = unembeddable.hash)`,
    hashes
  );
};

/** A file no version points at: what the sweep deletes, past its grace. */
const unreferencedFile = "refs = 0";

/** A vector row let go: what the sweep deletes, past its grace. */
const unheldVector = "unheld = 1";

/**
 * `?1` the grace (`fileGraceMs`): when the sweep (`sweepFiles`) next has a
 * file or a vector to look at, by the same conditions it takes them by: a
 * file no version points at, or a vector row marked unheld, once its
 * grace is over. Null when there is none.
 */
const sweepDueSql = `
SELECT min(at) AS at FROM (
  SELECT min(written_at) + ?1 AS at FROM files WHERE ${unreferencedFile}
  UNION ALL SELECT min(written_at) + ?1 FROM vector_files WHERE ${unheldVector}
)
HAVING min(at) IS NOT NULL`;

/** When the sweep next has something to look at (above), or null. */
export const sweepDueAt = (store: SqlStorage): number | null =>
  store.exec<{ at: number }>(sweepDueSql, fileGraceMs).toArray().at(0)?.at ??
  null;

/**
 * `?1` the cut-off: rows noted before it, `?2` how many. The oldest
 * unheld vector rows past the grace and not in doubt.
 */
const vectorsDueSql = `
SELECT model, hash FROM vector_files INDEXED BY vector_files_unheld_idx
WHERE ${unheldVector} AND written_at <= ?1
ORDER BY written_at
LIMIT ?2`;

/**
 * `?1` the rows (JSON, [model, hash] each): those still held, by a current
 * chunk of their text, in the host's model (or any while it runs none).
 */
const vectorsHeldSql = `
SELECT json_extract(due.value, '$[0]') AS model,
  json_extract(due.value, '$[1]') AS hash
FROM json_each(?1) AS due
WHERE coalesce((SELECT model FROM embedding_state), json_extract(due.value, '$[0]'))
    = json_extract(due.value, '$[0]')
  AND EXISTS (
    SELECT 1 FROM chunks
    JOIN current_versions ON current_versions.version_row = chunks.version_row
    WHERE chunks.hash = json_extract(due.value, '$[1]'))`;

/** Rows as JSON, [model, hash] each, for the queries above. */
const rowsJson = (rows: readonly VectorObject[]): string =>
  JSON.stringify(rows.map(({ model, hash }) => [model, hash]));

/**
 * The vector rows due for the sweep at `cutoff`: unheld, past the grace,
 * and not held again. Those held again are marked held.
 */
const vectorsDue = (store: SqlStorage, cutoff: number): VectorObject[] => {
  const candidates = store
    .exec<{ model: string; hash: string }>(
      vectorsDueSql,
      cutoff,
      vectorSweepBatch
    )
    .toArray();
  if (candidates.length === 0) {
    return [];
  }
  const held = store
    .exec<{ model: string; hash: string }>(vectorsHeldSql, rowsJson(candidates))
    .toArray();
  const heldKeys = new Set(
    held.map(({ model, hash }) => vectorKeyOf(model, hash))
  );
  if (held.length > 0) {
    store.exec(
      `UPDATE vector_files SET unheld = 0 WHERE (model, hash) IN (
        SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]')
        FROM json_each(?))`,
      rowsJson(held)
    );
  }
  return candidates.filter(
    ({ model, hash }) => !heldKeys.has(vectorKeyOf(model, hash))
  );
};

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
 * Deletes the objects of `keys` from R2, answering those it deleted: all
 * at once, or, when that fails, one by one, so an object R2 won't delete
 * never holds back the others.
 */
const deleteObjects = async (
  bucket: BrainBucket,
  keys: readonly string[]
): Promise<string[]> => {
  try {
    await bucket.delete([...keys]);
    return [...keys];
  } catch {
    const results = await Promise.allSettled(
      keys.map(async (key) => {
        await bucket.delete(key);
        return key;
      })
    );
    return results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []
    );
  }
};

/**
 * After a sweep's R2 call: the vector rows whose objects it deleted go,
 * if still due; the rest are noted afresh, so they go to the back and are
 * tried again a grace later, in doubt for that grace when R2 hung.
 */
const settleVectorSweep = (
  store: SqlStorage,
  due: readonly VectorObject[],
  deletedKeys: ReadonlySet<string>,
  cutoff: number,
  { timedOut }: { timedOut: boolean }
): void => {
  const isDeleted = ({ model, hash }: VectorObject): boolean =>
    deletedKeys.has(vectorKeyOf(model, hash));
  const gone = due.filter(isDeleted);
  const kept = due.filter((row) => !isDeleted(row));
  const rowsOf = `(model, hash) IN (
    SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]')
    FROM json_each(?))`;
  if (gone.length > 0) {
    store.exec(
      `DELETE FROM vector_files WHERE ${rowsOf} AND unheld = 1 AND written_at <= ?`,
      rowsJson(gone),
      cutoff
    );
  }
  if (kept.length > 0) {
    const now = Date.now();
    store.exec(
      `UPDATE vector_files SET written_at = ?, in_doubt_until = ?
      WHERE ${rowsOf} AND unheld = 1`,
      now,
      timedOut ? now + fileGraceMs : null,
      rowsJson(kept)
    );
  }
};

/**
 * Deletes the oldest batch of files no version points at that were noted
 * more than `fileGraceMs` before `at` (never later than now, so no caller's
 * clock shortens the grace), and of vector objects no current chunk holds
 * (above), in one R2 call: each from R2, then its row. A file R2 won't
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
  storage: DurableObjectStorage,
  db: DrizzleSqliteDODatabase,
  bucket: BrainBucket,
  at: Date
): Promise<"swept" | "idle" | "timed_out"> => {
  const asOf = Math.min(at.getTime(), Date.now());
  const unreferenced = and(
    sql.raw(unreferencedFile),
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
  const cutoff = asOf - fileGraceMs;
  const dueVectors = vectorsDue(storage.sql, cutoff);
  if (due.length === 0 && dueVectors.length === 0) {
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
  const answered = await Promise.race([
    deleteObjects(bucket, [
      ...due.map(fileKeyOf),
      ...dueVectors.map(({ model, hash }) => vectorKeyOf(model, hash)),
    ]),
    timedOut,
  ]);
  clearTimeout(timer);
  const deletedKeys = new Set(answered === "timed_out" ? [] : answered);
  const deleted = due.filter((hash) => deletedKeys.has(fileKeyOf(hash)));
  settleVectorSweep(storage.sql, dueVectors, deletedKeys, cutoff, {
    timedOut: answered === "timed_out",
  });
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
