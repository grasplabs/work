// What erasure deletes of memories (erasure.ts): the memories resting on
// a version it deletes, or those only an erased person may read, each
// with its names, its confirmations and those made over it; then each
// entity no memory mentions any more, so no name or identifier outlives
// the last memory that gave it. Run in the caller's transaction.

/** `rows` of memories deleted whole: answers the sets of readers they pointed at. */
const deleteMemories = (sql: SqlStorage, rows: readonly number[]): number[] => {
  if (rows.length === 0) {
    return [];
  }
  const listed = JSON.stringify(rows);
  const touched = sql
    .exec<{ entity: number | null; reader_set: number }>(
      `SELECT entity, reader_set FROM memories WHERE row IN (SELECT value FROM json_each(?1))
      UNION SELECT object, reader_set FROM memories
      WHERE row IN (SELECT value FROM json_each(?1)) AND object IS NOT NULL`,
      listed
    )
    .toArray();
  sql.exec(
    "DELETE FROM entity_names WHERE memory IN (SELECT value FROM json_each(?))",
    listed
  );
  sql.exec(
    `DELETE FROM memory_confirmed_over
    WHERE memory IN (SELECT value FROM json_each(?1))
      OR confirmation IN (SELECT row FROM memory_confirmations
        WHERE memory IN (SELECT value FROM json_each(?1)))`,
    listed
  );
  sql.exec(
    "DELETE FROM memory_confirmations WHERE memory IN (SELECT value FROM json_each(?))",
    listed
  );
  // Their words and stems go with them (migration 0008's trigger).
  sql.exec(
    "DELETE FROM memories WHERE row IN (SELECT value FROM json_each(?))",
    listed
  );
  // An entity others were merged into stays while it stands for them;
  // one merged into another leaves its merge with it.
  const orphans = `SELECT touched.value FROM json_each(?1) AS touched
    WHERE NOT EXISTS (SELECT 1 FROM memories WHERE memories.entity = touched.value)
      AND NOT EXISTS (SELECT 1 FROM memories WHERE memories.object = touched.value)
      AND NOT EXISTS (
        SELECT 1 FROM entity_merges WHERE entity_merges.into_entity = touched.value
      )`;
  const affected = JSON.stringify(
    touched.flatMap(({ entity }) => entity ?? [])
  );
  sql.exec(`DELETE FROM entity_merges WHERE merged IN (${orphans})`, affected);
  sql.exec(`DELETE FROM entities WHERE row IN (${orphans})`, affected);
  return [...new Set(touched.map(({ reader_set: readerSet }) => readerSet))];
};

/**
 * Deletes the memories resting on the version at `versionRow`, and its
 * mark of being fully extracted, as the version is deleted: answers the
 * memories' sets of readers.
 */
export const eraseMemoriesOn = (
  sql: SqlStorage,
  versionRow: number
): number[] => {
  sql.exec("DELETE FROM memory_extractions WHERE version_row = ?", versionRow);
  return deleteMemories(
    sql,
    sql
      .exec<{ row: number }>(
        "SELECT row FROM memories WHERE version_row = ?",
        versionRow
      )
      .toArray()
      .map(({ row }) => row)
  );
};

/**
 * Deletes the memories only the person the ledger names `subject` may
 * read, learned up to `at`, the erasure's time: what is learned for them
 * afterwards is new, and kept. Answers their sets of readers.
 */
export const eraseMemoriesOf = (
  sql: SqlStorage,
  subject: string,
  at: number
): number[] =>
  deleteMemories(
    sql,
    sql
      .exec<{ row: number }>(
        "SELECT row FROM memories WHERE only_for = ? AND learned_at <= ?",
        subject,
        at
      )
      .toArray()
      .map(({ row }) => row)
  );
