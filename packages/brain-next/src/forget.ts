// What erasure deletes of memories (erasure.ts): the memories resting on
// a version it deletes, or those only an erased person may read, each
// with its names and its confirmations; every confirmation made over one
// of them, whole, so none shows to readers the erased memory once hid it
// from; then each entity no memory mentions any more, so no name or
// identifier outlives the last memory that gave it. Run in the caller's
// transaction. Each answers the sets of readers (`reader_sets.id`) its
// memories and marks named by key, for the caller to drop once unused.

/** The ids of the stored sets of readers whose keys are `keys`. */
const setsOf = (sql: SqlStorage, keys: readonly string[]): number[] =>
  keys.length === 0
    ? []
    : sql
        .exec<{ id: number }>(
          "SELECT id FROM reader_sets WHERE key IN (SELECT value FROM json_each(?))",
          JSON.stringify([...new Set(keys)])
        )
        .toArray()
        .map(({ id }) => id);

/** `rows` of memories deleted whole: answers the sets of readers they named. */
const deleteMemories = (sql: SqlStorage, rows: readonly number[]): number[] => {
  if (rows.length === 0) {
    return [];
  }
  const listed = JSON.stringify(rows);
  const touched = sql
    .exec<{ entity: number | null; readers: string }>(
      `SELECT entity, readers FROM memories WHERE row IN (SELECT value FROM json_each(?1))
      UNION SELECT object, readers FROM memories
      WHERE row IN (SELECT value FROM json_each(?1)) AND object IS NOT NULL`,
      listed
    )
    .toArray();
  // Their confirmations, and every one made over any of them, whole.
  const confirmations = JSON.stringify(
    sql
      .exec<{ row: number }>(
        `SELECT row FROM memory_confirmations
        WHERE memory IN (SELECT value FROM json_each(?1))
        UNION SELECT confirmation FROM memory_confirmed_over
        WHERE memory IN (SELECT value FROM json_each(?1))`,
        listed
      )
      .toArray()
      .map(({ row }) => row)
  );
  sql.exec(
    `DELETE FROM memory_confirmed_over
    WHERE confirmation IN (SELECT value FROM json_each(?))`,
    confirmations
  );
  sql.exec(
    "DELETE FROM memory_confirmations WHERE row IN (SELECT value FROM json_each(?))",
    confirmations
  );
  sql.exec(
    "DELETE FROM entity_names WHERE memory IN (SELECT value FROM json_each(?))",
    listed
  );
  // Their words and stems go with them (migration 0008's trigger).
  sql.exec(
    "DELETE FROM memories WHERE row IN (SELECT value FROM json_each(?))",
    listed
  );
  sql.exec(
    `DELETE FROM entities WHERE row IN (
      SELECT touched.value FROM json_each(?1) AS touched
      WHERE NOT EXISTS (SELECT 1 FROM memories WHERE memories.entity = touched.value)
        AND NOT EXISTS (SELECT 1 FROM memories WHERE memories.object = touched.value)
    )`,
    JSON.stringify(touched.flatMap(({ entity }) => entity ?? []))
  );
  return setsOf(
    sql,
    touched.map(({ readers }) => readers)
  );
};

/** The rows of memories `statement` names with `bindings`. */
const rowsOf = (
  sql: SqlStorage,
  statement: string,
  ...bindings: SqlStorageValue[]
): number[] =>
  sql
    .exec<{ row: number }>(statement, ...bindings)
    .toArray()
    .map(({ row }) => row);

/**
 * Deletes the memories resting on the version at `versionRow`, and its
 * marks of being fully extracted, as the version is deleted: answers the
 * sets of readers they named.
 */
export const eraseMemoriesOn = (
  sql: SqlStorage,
  versionRow: number
): number[] => {
  const [version] = sql
    .exec<{ source: string; version: number }>(
      "SELECT source, version FROM source_versions WHERE row = ?",
      versionRow
    )
    .toArray();
  if (version === undefined) {
    return [];
  }
  const marks = sql
    .exec<{ readers: string }>(
      `DELETE FROM memory_extractions WHERE source = ? AND version = ?
      RETURNING readers`,
      version.source,
      version.version
    )
    .toArray()
    .map(({ readers }) => readers);
  return [
    ...setsOf(sql, marks),
    ...deleteMemories(
      sql,
      rowsOf(
        sql,
        "SELECT row FROM memories WHERE source = ? AND version = ?",
        version.source,
        version.version
      )
    ),
  ];
};

/**
 * Deletes the memories only the person the ledger names `subject` may
 * read, learned up to `at`, the erasure's time, and the extraction marks
 * of adds only they read: what is learned for them afterwards is new, and
 * kept. Answers the sets of readers they named.
 */
export const eraseMemoriesOf = (
  sql: SqlStorage,
  subject: string,
  at: number
): number[] => {
  const marks = sql
    .exec<{ readers: string }>(
      `DELETE FROM memory_extractions WHERE only_for = ? AND at <= ?
      RETURNING readers`,
      subject,
      at
    )
    .toArray()
    .map(({ readers }) => readers);
  return [
    ...setsOf(sql, marks),
    ...deleteMemories(
      sql,
      rowsOf(
        sql,
        "SELECT row FROM memories WHERE only_for = ? AND learned_at <= ?",
        subject,
        at
      )
    ),
  ];
};

/**
 * Deletes the memories and extraction marks of the source the ledger
 * names `subject`, every version: what a source's erasure covered. Answers
 * the sets of readers they named.
 */
export const eraseMemoriesOfSource = (
  sql: SqlStorage,
  subject: string
): number[] => {
  const marks = sql
    .exec<{ readers: string }>(
      "DELETE FROM memory_extractions WHERE subject = ? RETURNING readers",
      subject
    )
    .toArray()
    .map(({ readers }) => readers);
  return [
    ...setsOf(sql, marks),
    ...deleteMemories(
      sql,
      rowsOf(sql, "SELECT row FROM memories WHERE subject = ?", subject)
    ),
  ];
};

/**
 * Deletes the memories and extraction marks resting on the versions the
 * person's erasure `erasure` hid (`erased_versions`): what it covered of
 * sources others read too. Answers the sets of readers they named.
 */
export const eraseMemoriesHiddenBy = (
  sql: SqlStorage,
  erasure: string
): number[] => {
  const marks = sql
    .exec<{ readers: string }>(
      `DELETE FROM memory_extractions
      WHERE (subject, version) IN (
        SELECT subject, version FROM erased_versions WHERE erasure = ?
      )
      RETURNING readers`,
      erasure
    )
    .toArray()
    .map(({ readers }) => readers);
  return [
    ...setsOf(sql, marks),
    ...deleteMemories(
      sql,
      rowsOf(
        sql,
        `SELECT memories.row AS row FROM erased_versions
        JOIN memories ON memories.subject = erased_versions.subject
          AND memories.version = erased_versions.version
        WHERE erased_versions.erasure = ?`,
        erasure
      )
    ),
  ];
};
