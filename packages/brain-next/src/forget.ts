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
  // Proposals name the memories whose names matched: they go with
  // either, with each person's decision on them.
  const proposals = `SELECT row FROM entity_proposals
    WHERE memory IN (SELECT value FROM json_each(?1))
      OR candidate_memory IN (SELECT value FROM json_each(?1))`;
  sql.exec(
    `DELETE FROM entity_proposal_decisions WHERE proposal IN (${proposals})`,
    listed
  );
  sql.exec(`DELETE FROM entity_proposals WHERE row IN (${proposals})`, listed);
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
  const orphans = `SELECT touched.value FROM json_each(?1) AS touched
    WHERE NOT EXISTS (SELECT 1 FROM memories WHERE memories.entity = touched.value)
      AND NOT EXISTS (SELECT 1 FROM memories WHERE memories.object = touched.value)
      AND NOT EXISTS (
        SELECT 1 FROM member_entities WHERE member_entities.entity = touched.value
      )`;
  const affected = JSON.stringify(
    touched.flatMap(({ entity }) => entity ?? [])
  );
  // A person's joins go with either entity they join.
  sql.exec(
    `DELETE FROM entity_joins WHERE merged IN (${orphans}) OR into_entity IN (${orphans})`,
    affected
  );
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
 * read, learned up to `at`, the erasure's time, and the extraction marks
 * of adds only they read: what is learned for them afterwards is new, and
 * kept. Answers their sets of readers.
 */
export const eraseMemoriesOf = (
  sql: SqlStorage,
  subject: string,
  at: number
): number[] => {
  const markers = sql
    .exec<{ reader_set: number }>(
      `DELETE FROM memory_extractions WHERE only_for = ? AND at <= ?
      RETURNING reader_set`,
      subject,
      at
    )
    .toArray()
    .map(({ reader_set: readerSet }) => readerSet);
  return [
    ...markers,
    ...deleteMemories(
      sql,
      sql
        .exec<{ row: number }>(
          "SELECT row FROM memories WHERE only_for = ? AND learned_at <= ?",
          subject,
          at
        )
        .toArray()
        .map(({ row }) => row)
    ),
  ];
};

/**
 * Deletes what the person the ledger names `subject` linked and joined:
 * their member link, and their entity with it once no memory mentions
 * it; their decisions on proposals and the joins those made. An erasure,
 * or its replay after a restore, leaves nothing that ties them to an
 * entity.
 */
export const eraseLinksOf = (sql: SqlStorage, subject: string): void => {
  sql.exec("DELETE FROM entity_joins WHERE only_for = ?", subject);
  sql.exec("DELETE FROM entity_proposal_decisions WHERE only_for = ?", subject);
  const affected = JSON.stringify(
    sql
      .exec<{ entity: number }>(
        "DELETE FROM member_entities WHERE subject = ? RETURNING entity",
        subject
      )
      .toArray()
      .map(({ entity }) => entity)
  );
  // As `deleteMemories` deletes an entity no memory mentions any more.
  const orphans = `SELECT linked.value FROM json_each(?1) AS linked
    WHERE NOT EXISTS (SELECT 1 FROM memories WHERE memories.entity = linked.value)
      AND NOT EXISTS (SELECT 1 FROM memories WHERE memories.object = linked.value)`;
  sql.exec(
    `DELETE FROM entity_joins WHERE merged IN (${orphans}) OR into_entity IN (${orphans})`,
    affected
  );
  sql.exec(`DELETE FROM entities WHERE row IN (${orphans})`, affected);
};
