import { removedSource, restoringNow } from "./contract.ts";
import { isErased, subjectOf } from "./erasure.ts";
import { releaseVectors } from "./files.ts";
import { isRestoring } from "./restoring.ts";
import { removeVectorsOf } from "./vectors.ts";

// Removal: a source taken out of use for good, its history kept. Apart
// from erasure, which leaves nothing: a removal deletes no version, chunk,
// change key, memory or file, and writes nothing to the ledger. It drops
// the source's current pointer, and every statement that reads, lists,
// counts or recalls a source or a memory needs a current version its
// reader may read (sources.ts, listing.ts, recall.ts, memories.ts
// `visibleSql`, entities.ts): so a removed source, and everything drawn
// from it, answers as one no one added, to every reader, from the
// statement after. Its history is kept for no reader: nothing reads it,
// and nothing puts it back in use. Only an erasure goes further, and
// takes the rest (erasure.ts).
//
// In the one transaction that removes it: the current pointer goes, the
// codes of its current version leave the vector scan (as a replaced
// version's do), its queued work goes (work about a source is keyed by
// its key), and its mark is written (`removed_sources`): its key, as the
// ledger names keys, and the version that was current. While the mark is
// there, an add to its key is refused (`removedSource`), asked before the
// add writes its file and again in the transaction that would record it
// (sources.ts), so an add racing the removal never brings it back; and
// so is drawing a memory from any of its versions (remember.ts).
//
// An export holds a removed source's versions with the one that was
// current marked, and a restore puts the mark back: it comes back removed
// (exports.ts, restore.ts). An erasure that hides the marked version
// clears the mark's pointer to it, and one of its key deletes the mark,
// so no plain key outlives what it named (erasure.ts).

/** Whether `source` was removed: its key is closed to adds. */
export const isRemoved = (sql: SqlStorage, source: string): boolean =>
  sql
    .exec("SELECT 1 FROM removed_sources WHERE source = ? LIMIT 1", source)
    .toArray().length > 0;

/** Refuses an add to `source` when it was removed. */
export const refuseRemoved = (sql: SqlStorage, source: string): void => {
  if (isRemoved(sql, source)) {
    throw new Error(removedSource);
  }
};

/**
 * Takes `source` out of use for good, keeping its history (above), in one
 * transaction: whether it was removed by this call, so its caller stops
 * work under way on it. A key already removed, or erased (closed and
 * holding nothing), is left as it is; one that holds nothing yet is
 * closed all the same, so an add that began before the removal never
 * lands after it. Refused while a restore runs, as an add is: a restore
 * could otherwise point the source at a current version after it.
 */
export const removeSource = async (
  storage: DurableObjectStorage,
  source: string
): Promise<boolean> => {
  const subject = await subjectOf(source);
  return storage.transactionSync(() => {
    const { sql } = storage;
    if (isRestoring(sql)) {
      throw new Error(restoringNow);
    }
    if (isRemoved(sql, source) || isErased(sql, subject)) {
      return false;
    }
    const current =
      sql
        .exec<{ version_row: number }>(
          "SELECT version_row FROM current_versions WHERE source = ?",
          source
        )
        .toArray()
        .at(0)?.version_row ?? null;
    if (current !== null) {
      removeVectorsOf(sql, current);
      sql.exec("DELETE FROM current_versions WHERE source = ?", source);
      // Their full vectors too, once no current chunk holds their text:
      // the sweep checks and deletes (files.ts).
      releaseVectors(
        sql,
        JSON.stringify(
          sql
            .exec<{ hash: string }>(
              "SELECT hash FROM chunks WHERE version_row = ? AND hash IS NOT NULL",
              current
            )
            .toArray()
            .map(({ hash }) => hash)
        )
      );
    }
    sql.exec("DELETE FROM work_items WHERE key = ?", source);
    sql.exec(
      "INSERT INTO removed_sources (source, subject, version_row) VALUES (?, ?, ?)",
      source,
      subject,
      current
    );
    return true;
  });
};
