import type {
  Reader,
  RetiredMemory,
  WrittenCursor,
  WrittenMemory,
  WrittenPage,
} from "./contract.ts";
import {
  lineageOfWriter,
  memoriesSql,
  memoryOf,
  memoryRows,
  newerSql,
  nextStamp,
  raiseStamp,
  readMoment,
  unerasedSql,
} from "./memories.ts";
import { accessOfKey } from "./reader-sets.ts";

// What one writer wrote (contract.ts `listWritten`, `retireWritten`): a
// person's own word in the shared store (core's share of a memory), which
// its writer may list and take back whoever may read it now, as their
// own. Taking back removes and reads nothing; a listing gives a memory's
// text only to a reader who may read it, and of any other its id, its
// readers and when it was learned alone. Only what is current is listed
// or taken back as such: one a newer memory of the writer's ended, or
// whose time is over, is history.

/**
 * `?1` the writer's subject (`writer_subject`), `?2` their lineage, `?3`
 * the cursor's moment (milliseconds) and `?4` its memory id, or null for
 * the first page; `?5` the limit, `?6` the moment read at: their memories
 * current then (not retired, not ended by a newer one of theirs, their
 * time not over) and not hidden by an erasure, by when they were learned,
 * then id. One seek of `memories_writer_idx`.
 */
const writtenSql = `SELECT m.row AS row, m.id AS id, m.readers AS readers,
    m.learned_at AS learned_at
  FROM memories AS m
  WHERE m.writer_subject = ?1 AND m.lineage = ?2 AND m.retired_at IS NULL
    AND m.learned_at <= ?6
    AND (m.valid_until IS NULL OR m.valid_until > ?6)
    AND NOT EXISTS (${newerSql("m", "?6", "?6", false)})
    AND (?3 IS NULL OR m.learned_at > ?3 OR (m.learned_at = ?3 AND m.id > ?4))
    AND ${unerasedSql("m")}
  ORDER BY m.learned_at, m.id
  LIMIT ?5`;

/** `?1` rows (JSON): those of them the reader may read, current or not, as `memoriesSql` judges them. */
const readableRowsSql = memoriesSql({
  base: `SELECT m.row FROM json_each(?1) AS asked
    CROSS JOIN memories AS m ON m.row = asked.value`,
  filter: "1",
  order: "m.row",
});

/**
 * A page of what `writer` (whose subject is `subject`) wrote and hasn't
 * retired, at most `limit`, after `after`, for `reader`: each with its
 * readers and when it was learned, and the memory itself only when the
 * reader may read it. One synchronous step, so both statements read one
 * snapshot.
 */
export const listWritten = (
  sql: SqlStorage,
  {
    writer,
    subject,
    reader,
    after,
    limit,
  }: {
    writer: string;
    subject: string;
    reader: Reader;
    after: WrittenCursor | undefined;
    limit: number;
  }
): WrittenPage => {
  const at = readMoment(sql);
  const rows = sql
    .exec<{ row: number; id: string; readers: string; learned_at: number }>(
      writtenSql,
      subject,
      lineageOfWriter(writer),
      after?.learnedAt.getTime() ?? null,
      after?.memory ?? null,
      // One more than a page: whether more follow.
      limit + 1,
      at
    )
    .toArray();
  const page = rows.slice(0, limit);
  const readable = new Map(
    memoryRows(
      sql,
      readableRowsSql,
      JSON.stringify(page.map(({ row }) => row)),
      reader,
      at,
      -1
    ).map((row) => [row.row, memoryOf(row)])
  );
  const memories: WrittenMemory[] = page.map(
    ({ row, id, readers, learned_at: learnedAt }) => ({
      id,
      access: accessOfKey(readers) ?? null,
      learnedAt: new Date(learnedAt),
      memory: readable.get(row) ?? null,
    })
  );
  const last = page.at(-1);
  return rows.length > limit && last !== undefined
    ? {
        memories,
        more: true,
        next: { learnedAt: new Date(last.learned_at), memory: last.id },
      }
    : { memories, more: false };
};

/**
 * Retires memory `id` of `writer`'s own lineage, whoever may read it:
 * when and by which change (`RetiredMemory`), the same again for one this
 * writer retired before. Null for no such memory, another writer's, and
 * one an erasure hides. In the caller's transaction.
 *
 * In the same statement, every older memory of theirs it ends (memories.ts
 * `newerSql`: the same entity and attribute, and for an attribute of many
 * values or none, the same value) is retired too, under the same change:
 * a retired memory ends nothing, so taking back the newer of two copies
 * would otherwise make the older one current again for its readers.
 */
export const retireWritten = (
  sql: SqlStorage,
  { id, writer, change }: { id: string; writer: string; change: string }
): RetiredMemory | null => {
  const stamp = nextStamp(sql);
  const retiredRows = sql
    .exec<{ id: string; retired_at: number; retired_change: string | null }>(
      `WITH taken AS MATERIALIZED (
        SELECT m.row, m.entity, m.attribute, m.one_value, m.value_key,
          m.lineage_order
        FROM memories AS m
        WHERE m.id = ?1 AND m.lineage = ?2 AND m.retired_at IS NULL
          AND ${unerasedSql("m")}
      )
      UPDATE memories AS m SET retired_at = ?3, retired_change = ?4
      WHERE m.lineage = ?2 AND m.retired_at IS NULL AND ${unerasedSql("m")}
        AND EXISTS (
          SELECT 1 FROM taken WHERE taken.row = m.row
            OR (taken.entity = m.entity
              AND (taken.lineage_order > m.lineage_order
                OR (taken.lineage_order = m.lineage_order AND taken.row > m.row))
              AND ((m.one_value = 1 AND m.attribute = taken.attribute)
                OR (m.one_value = 0 AND m.attribute IS taken.attribute
                  AND m.value_key = taken.value_key)))
        )
      RETURNING id, retired_at, retired_change`,
      id,
      lineageOfWriter(writer),
      stamp,
      change
    )
    .toArray();
  const retired = retiredRows.find((row) => row.id === id);
  if (retired !== undefined) {
    raiseStamp(sql, stamp);
    return {
      retiredAt: new Date(retired.retired_at),
      change: retired.retired_change,
    };
  }
  const [again] = sql
    .exec<{ retired_at: number; retired_change: string | null }>(
      `SELECT m.retired_at, m.retired_change FROM memories AS m
      WHERE m.id = ?1 AND m.lineage = ?2 AND m.retired_at IS NOT NULL
        AND ${unerasedSql("m")}`,
      id,
      lineageOfWriter(writer)
    )
    .toArray();
  return again === undefined
    ? null
    : { retiredAt: new Date(again.retired_at), change: again.retired_change };
};
