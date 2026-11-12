import { z } from "zod";

import { memoryTypes, recallLimit, speakerSchema } from "./contract.ts";
import type {
  ContestedFact,
  EntityId,
  Memory,
  MemoryChangeOutcome,
  Reader,
} from "./contract.ts";
import { readableSql } from "./reader-sets.ts";
import { termsOf } from "./words.ts";

// Memories (contract.ts "Memories and entities"): small dated statements
// about an entity, each of one lineage (the source it rests on, or its
// writer), never written over. What is current is read, never stored: a
// memory is ended by a newer one of its lineage about the same entity and
// one-value attribute (or the same value, for one of many), counted only
// when the reader may read the newer one, so a reader is told what a
// store without the memories hidden from them would tell; or by its
// writer retiring it, the one change ever written to a memory. A
// time-bound one stops being current at its end (`validUntil`).
//
// Every statement here filters by the reader inside itself, before
// anything is ordered, counted or capped: a memory's own set of readers,
// and, when it rests on a version, that version's readers and the
// source's current version's, the version not hidden by an erasure
// (`visibleSql`). So narrowing a source, or erasing it, hides what was
// drawn from it from the next statement on, history included.
//
// Contested and confirmed are read the same way: a memory is contested
// when the reader may read another current memory of the same entity and
// one-value attribute that says something else (one lineage has one
// current memory of it, so that one is of another lineage); a
// confirmation counts for a reader who may read the memory and every
// memory it was confirmed over.
//
// The statements bind the reader as `readableSql` does (`?2` the person,
// `?3` their groups), the moment read as of at `?4` (milliseconds; now,
// unless asked as of one), and the limit at `?5`.

/**
 * Whether the reader may read the version at `row` (an expression): among
 * its readers and its source's current version's, and no erasure hides
 * it.
 */
const versionVisibleSql = (row: string): string => `EXISTS (
    SELECT 1 FROM source_versions AS based
    JOIN current_versions ON current_versions.source = based.source
    JOIN source_versions AS current ON current.row = current_versions.version_row
    WHERE based.row = ${row}
      AND based.row NOT IN (SELECT version_row FROM erasing_versions)
      AND based.reader_set IN (SELECT reader_set FROM readable)
      AND current.reader_set IN (SELECT reader_set FROM readable)
  )`;

/**
 * The conditions under which the memory `alias` is visible to the reader:
 * in its set of readers, and, resting on a version, in that version's and
 * its source's current version's, that version not hidden by an erasure.
 */
export const visibleSql = (alias: string): string => `(
  ${alias}.reader_set IN (SELECT reader_set FROM readable)
  AND (${alias}.version_row IS NULL OR ${versionVisibleSql(`${alias}.version_row`)})
)`;

/** When a memory starts to count: when it was learned, or its world start if later. */
const startSql = (alias: string): string =>
  `max(${alias}.learned_at, coalesce(${alias}.valid_from, ${alias}.learned_at))`;

/**
 * The newer memories of `alias`'s lineage that end it, by the order of
 * its lineage (a later version's, or a later row of the same), about the
 * same entity and attribute and, for an attribute of many values, the
 * same value, each from when it starts, by `at` (a parameter). None for a
 * memory with no attribute. `visible` keeps to those the reader may read.
 */
const newerSql = (alias: string, at: string, visible: boolean): string => `
  SELECT ${startSql("newer")} AS at FROM memories AS newer
  WHERE newer.entity = ${alias}.entity
    AND newer.attribute = ${alias}.attribute
    AND newer.lineage = ${alias}.lineage
    AND (${alias}.one_value = 1 OR newer.value_key = ${alias}.value_key)
    AND (newer.lineage_order > ${alias}.lineage_order
      OR (newer.lineage_order = ${alias}.lineage_order AND newer.row > ${alias}.row))
    AND ${startSql("newer")} <= ${at}
    ${visible ? `AND ${visibleSql("newer")}` : ""}`;

/**
 * The later versions of `alias`'s source marked fully extracted by `?4`,
 * for readers of both the add that marked it and that version: each ends
 * every memory of an earlier version of it, whatever its attribute
 * (contract.ts `extracted`).
 */
const extractedSql = (alias: string): string => `
  SELECT extracted.at AS at FROM memory_extractions AS extracted
  WHERE extracted.lineage = ${alias}.lineage
    AND extracted.version > ${alias}.lineage_order
    AND extracted.at <= ?4
    AND extracted.reader_set IN (SELECT reader_set FROM readable)
    AND ${versionVisibleSql("extracted.version_row")}`;

/**
 * When the reader saw `m` stop being believed, as of `?4`: retired then,
 * or ended by a newer memory of its lineage they may read, from its
 * start, or by a later version of its source marked fully extracted;
 * never before it was learned itself (an older version's memory that came
 * late is history from the start). Null while believed.
 */
const endedAtSql = `max(m.learned_at, (SELECT min(at) FROM (
  SELECT m.retired_at AS at WHERE m.retired_at IS NOT NULL AND m.retired_at <= ?4
  UNION ALL${newerSql("m", "?4", true)}
  UNION ALL${extractedSql("m")}
)))`;

/** A current rival of `m` the reader may read: judged current, same fact, another value. */
const rivalSql = `
    SELECT 1 FROM judged AS other
    JOIN memories AS rival ON rival.row = other.row
    WHERE other.is_current = 1 AND m.one_value = 1
      AND rival.entity = m.entity
      AND rival.attribute = m.attribute AND rival.value_key IS NOT m.value_key`;

/**
 * The latest confirmation of `m` that counts for the reader, as JSON, or
 * null: one made over memories they may all read, and over every current
 * rival they may read, so one made without seeing a rival never ranks
 * first for a reader who sees it.
 */
const confirmationSql = `(
  SELECT json_object('by', confirmed.person, 'at', confirmed.at)
  FROM memory_confirmations AS confirmed
  WHERE confirmed.memory = m.row AND confirmed.at <= ?4
    AND NOT EXISTS (
      SELECT 1 FROM memory_confirmed_over AS overruled
      JOIN memories AS other ON other.row = overruled.memory
      WHERE overruled.confirmation = confirmed.row AND NOT ${visibleSql("other")}
    )
    AND NOT EXISTS (${rivalSql}
      AND rival.row NOT IN (
        SELECT memory FROM memory_confirmed_over WHERE confirmation = confirmed.row
      )
    )
  ORDER BY confirmed.at DESC, confirmed.row DESC
  LIMIT 1
)`;

/** A memory as the statements below return it. */
export interface MemoryRow extends Record<string, SqlStorageValue> {
  row: number;
  entity_row: number;
  id: string;
  about: string;
  attribute: string | null;
  object: string | null;
  value: string | null;
  value_key: string | null;
  lineage: string;
  type: string;
  statement: string;
  quote: string | null;
  source: string | null;
  version: number | null;
  version_row: number | null;
  writer: string | null;
  speaker: string;
  valid_from: number | null;
  valid_until: number | null;
  learned_at: number;
  ended_at: number | null;
  is_current: number;
  contested: number;
  confirmation: string | null;
}

/** What a statement over memories is made of (`memoriesSql`). */
export interface MemoriesQuery {
  /** Common tables the others use, after `readable`. */
  prelude?: string;
  /** The memories asked about, as rows (`row`). */
  base: string;
  /** Which of them to return, with `judged` and `m` (the memory) at hand. */
  filter: string;
  /** Their order. */
  order: string;
  /** More joins, for `filter` and `order`. */
  joins?: string;
  /** More columns, from those joins. */
  columns?: string;
  /**
   * The statement over the rows, given them as the common table `rows`:
   * what is returned of them, in which order. Without it, the rows
   * themselves, by `order`, at most `?5`.
   */
  outer?: string;
}

/**
 * A statement over the memories `base` names, as the reader sees them as
 * of `?4`: each with when it ended for them, whether it is current then,
 * contested, and its latest confirmation they may see. Every memory the
 * reader may not read is left out before anything is judged, so the
 * memories a reader may read are judged alike whatever else is stored. The
 * memories that may contest one asked about (the same entity and
 * one-value attribute) are judged with them, and returned only if asked
 * about too.
 */
export const memoriesSql = ({
  prelude,
  base,
  filter,
  order,
  joins = "",
  columns = "",
  outer,
}: MemoriesQuery): string => {
  const tables = `
WITH ${readableSql},${prelude === undefined ? "" : `\n${prelude},`}
base AS MATERIALIZED (${base}),
candidates AS MATERIALIZED (
  SELECT row FROM base
  UNION
  SELECT partner.row FROM base
  JOIN memories AS asked ON asked.row = base.row AND asked.one_value = 1
  JOIN memories AS partner
    ON partner.attribute = asked.attribute
    AND partner.entity = asked.entity
),
seen AS MATERIALIZED (
  SELECT m.row AS row, ${endedAtSql} AS ended_at
  FROM candidates
  JOIN memories AS m ON m.row = candidates.row
  WHERE m.learned_at <= ?4 AND ${visibleSql("m")}
),
judged AS MATERIALIZED (
  SELECT seen.row AS row, seen.ended_at AS ended_at,
    (seen.ended_at IS NULL
      AND (m.valid_from IS NULL OR m.valid_from <= ?4)
      AND (m.valid_until IS NULL OR m.valid_until > ?4)) AS is_current
  FROM seen JOIN memories AS m ON m.row = seen.row
)`;
  const select = `
SELECT m.row AS row, about.row AS entity_row, m.id AS id, about.id AS about,
  m.attribute AS attribute, object.id AS object, m.value AS value,
  m.value_key AS value_key, m.lineage AS lineage, m.type AS type,
  m.statement AS statement, m.quote AS quote, based.source AS source,
  based.version AS version, m.version_row AS version_row, m.writer AS writer, m.speaker AS speaker,
  m.valid_from AS valid_from, m.valid_until AS valid_until,
  m.learned_at AS learned_at, judged.ended_at AS ended_at,
  judged.is_current AS is_current,
  (judged.is_current = 1 AND EXISTS (${rivalSql})) AS contested,
  ${confirmationSql} AS confirmation${columns}
FROM judged
JOIN memories AS m ON m.row = judged.row
JOIN entities AS about ON about.row = m.entity
LEFT JOIN entities AS object ON object.row = m.object
LEFT JOIN source_versions AS based ON based.row = m.version_row${joins}
WHERE judged.row IN (SELECT row FROM base) AND ${filter}`;
  return outer === undefined
    ? `${tables}${select}\nORDER BY ${order}\nLIMIT ?5`
    : `${tables},\nrows AS (${select}\n)\n${outer}`;
};

/** The lineage of a writer's memories. */
export const lineageOfWriter = (writer: string): string => `writer:${writer}`;

/** The lineage of the memories drawn from a source, every version of it. */
export const lineageOfSource = (source: string): string => `source:${source}`;

/** A date of a memory, from its milliseconds. */
const dateOf = (at: number | null): Date | null =>
  at === null ? null : new Date(at);

/** A confirmation as `confirmationSql` builds it. */
const confirmationSchema = z.strictObject({ by: z.string(), at: z.number() });

/** A memory's type as stored. */
const memoryTypeSchema = z.enum(memoryTypes);

/** A confirmation as `confirmationSql` gives it, or none. */
const confirmationOf = (
  json: string | null
): { by: string; at: number } | null => {
  if (json === null) {
    return null;
  }
  return confirmationSchema.parse(JSON.parse(json));
};

/** `row` as the contract's `Memory`. */
export const memoryOf = (row: MemoryRow): Memory => {
  const confirmed = confirmationOf(row.confirmation);
  return {
    id: row.id,
    about: row.about,
    attribute: row.attribute,
    object: row.object,
    value: row.value,
    type: memoryTypeSchema.parse(row.type),
    statement: row.statement,
    quote: row.quote,
    source:
      row.source === null || row.version === null
        ? null
        : { source: row.source, version: row.version },
    writer: row.writer,
    speaker: speakerSchema.parse(JSON.parse(row.speaker)),
    validFrom: dateOf(row.valid_from),
    validUntil: dateOf(row.valid_until),
    learnedAt: new Date(row.learned_at),
    endedAt: dateOf(row.ended_at),
    confirmed:
      confirmed === null
        ? null
        : { by: confirmed.by, at: new Date(confirmed.at) },
    contested: row.contested === 1,
  };
};

/** Runs a statement over memories with its bindings, as rows. */
export const memoryRows = (
  sql: SqlStorage,
  statement: string,
  first: SqlStorageValue,
  reader: Reader,
  at: number,
  limit: number,
  ...rest: SqlStorageValue[]
): MemoryRow[] =>
  sql
    .exec<MemoryRow>(
      statement,
      first,
      reader.person,
      JSON.stringify(reader.groups),
      at,
      limit,
      ...rest
    )
    .toArray();

/** The row and kind of the entity `id`, or none. */
export const entityRowOf = (
  sql: SqlStorage,
  id: EntityId
): { row: number; kind: string } | undefined =>
  sql
    .exec<{ row: number; kind: string }>(
      "SELECT row, kind FROM entities WHERE id = ?",
      id
    )
    .toArray()
    .at(0);

/** The order memories about an entity are read in. */
const aboutOrder = `m.attribute IS NULL, m.attribute, confirmation IS NULL,
  m.learned_at DESC, m.row DESC`;

/**
 * `?1` the entity's row, `?6` the attribute or null, `?7` 1 for history
 * too: the memories about the entity, as subject or as what a relation
 * relates to.
 */
const aboutSql = memoriesSql({
  base: `SELECT row FROM memories
    WHERE entity = ?1 AND (?6 IS NULL OR attribute = ?6)
    UNION SELECT row FROM memories
    WHERE object = ?1 AND (?6 IS NULL OR attribute = ?6)`,
  filter: "(?7 = 1 OR judged.is_current = 1)",
  order: aboutOrder,
});

/** What reads of memories are asked with. */
export interface MemoriesAsked {
  entity: EntityId;
  reader: Reader;
  attribute?: string;
  at: number;
  history: boolean;
  limit: number;
}

/** The memories about an entity the reader may read (contract.ts `readMemories`). */
export const readMemories = (
  sql: SqlStorage,
  { entity, reader, attribute, at, history, limit }: MemoriesAsked
): Memory[] => {
  const found = entityRowOf(sql, entity);
  if (found === undefined) {
    return [];
  }
  return memoryRows(
    sql,
    aboutSql,
    found.row,
    reader,
    at,
    limit,
    attribute ?? null,
    history ? 1 : 0
  ).map(memoryOf);
};

/**
 * `?1` the entity's row or null, `?6` the most facts: the current,
 * contested memories of one-value attributes, of the first `?6` facts in
 * the order of each fact's first memory the reader may read, so where a
 * fact stands, and whether it is listed, depends on nothing hidden.
 */
// Its cost: without an entity, every current one-value memory the reader
// may read is judged (with its ending and its rivals) before the facts
// are ranked and cut, so it grows with the store, not with the limit. No
// cheap bound keeps the answer exact: a fact's first readable memory may
// be any of them. Measure before a client's scale; an entity narrows it
// to that entity's memories.
const contestedSql = memoriesSql({
  base: `SELECT row FROM memories
    WHERE one_value = 1 AND attribute IS NOT NULL
      AND (?1 IS NULL OR entity = ?1)`,
  filter: `judged.is_current = 1 AND contested = 1`,
  order: "m.row",
  outer: `SELECT rows.* FROM rows
JOIN (
  SELECT entity_row, attribute, min(row) AS first FROM rows
  GROUP BY entity_row, attribute
  ORDER BY first
  LIMIT ?6
) AS facts ON facts.entity_row = rows.entity_row AND facts.attribute = rows.attribute
ORDER BY facts.first, rows.confirmation IS NULL, rows.learned_at DESC, rows.row DESC`,
});

/** The contested facts the reader may read (contract.ts `listContested`). */
export const listContested = (
  sql: SqlStorage,
  {
    entity,
    reader,
    at,
    limit,
  }: { entity?: EntityId; reader: Reader; at: number; limit: number }
): ContestedFact[] => {
  let entityRow: number | null = null;
  if (entity !== undefined) {
    const found = entityRowOf(sql, entity);
    if (found === undefined) {
      return [];
    }
    entityRow = found.row;
  }
  const facts = new Map<string, ContestedFact>();
  for (const row of memoryRows(
    sql,
    contestedSql,
    entityRow,
    reader,
    at,
    -1,
    limit
  )) {
    const key = JSON.stringify([row.entity_row, row.attribute]);
    const fact = facts.get(key) ?? {
      about: row.about,
      attribute: row.attribute ?? "",
      memories: [],
    };
    fact.memories.push(memoryOf(row));
    facts.set(key, fact);
  }
  return [...facts.values()];
};

/** `?1` the memory's id: that memory, if current for the reader. */
const currentOneSql = memoriesSql({
  base: "SELECT row FROM memories WHERE id = ?1",
  filter: "judged.is_current = 1",
  order: "m.row",
});

/**
 * `?1` the entity's row, `?6` the attribute: its current memories the
 * reader may read.
 */
const currentOfAttributeSql = memoriesSql({
  base: `SELECT row FROM memories
    WHERE entity = ?1 AND attribute = ?6`,
  filter: "judged.is_current = 1",
  order: "m.row",
});

/**
 * The reader confirms the memory `id`, current and readable to them, over
 * the current memories they may read that say something else of its
 * entity and one-value attribute (contract.ts `confirmMemory`). Run in one
 * transaction: what it reads and writes is one snapshot.
 */
export const confirmMemory = (
  sql: SqlStorage,
  { id, reader, at }: { id: string; reader: Reader; at: number }
): MemoryChangeOutcome => {
  const [target] = memoryRows(sql, currentOneSql, id, reader, at, 1);
  if (target === undefined) {
    return "nothing";
  }
  const over =
    target.attribute === null || target.contested === 0
      ? []
      : memoryRows(
          sql,
          currentOfAttributeSql,
          target.entity_row,
          reader,
          at,
          -1,
          target.attribute
        ).filter(({ value_key: key }) => key !== target.value_key);
  const overRows = JSON.stringify(over.map((memory) => memory.row));
  // The same person over the same rivals again: already recorded.
  const [again] = sql
    .exec(
      `SELECT 1 FROM memory_confirmations AS confirmed
      WHERE confirmed.memory = ?1 AND confirmed.person = ?2
        AND (SELECT count(*) FROM memory_confirmed_over AS overruled
          WHERE overruled.confirmation = confirmed.row) = json_array_length(?3)
        AND NOT EXISTS (SELECT 1 FROM memory_confirmed_over AS overruled
          WHERE overruled.confirmation = confirmed.row
            AND overruled.memory NOT IN (SELECT value FROM json_each(?3)))`,
      target.row,
      reader.person,
      overRows
    )
    .toArray();
  if (again !== undefined) {
    return "done";
  }
  const { row } = sql
    .exec<{ row: number }>(
      "INSERT INTO memory_confirmations (memory, person, at) VALUES (?, ?, ?) RETURNING row",
      target.row,
      reader.person,
      at
    )
    .one();
  sql.exec(
    `INSERT INTO memory_confirmed_over (confirmation, memory)
    SELECT ?, value FROM json_each(?)`,
    row,
    overRows
  );
  return "done";
};

/**
 * Retires the memory `id` if its lineage is `writer`'s, the reader may
 * read it, and it is still believed as they see it: not retired, and no
 * newer memory of its lineage that they may read ended it by now, so one
 * hidden from them neither blocks the retire nor shows (contract.ts
 * `retireMemory`).
 */
export const retireMemory = (
  sql: SqlStorage,
  {
    id,
    writer,
    reader,
    at,
  }: { id: string; writer: string; reader: Reader; at: number }
): MemoryChangeOutcome => {
  const retired = sql.exec(
    `WITH ${readableSql}
    UPDATE memories AS m SET retired_at = ?5
    WHERE m.id = ?1 AND m.lineage = ?4 AND m.retired_at IS NULL
      AND ${visibleSql("m")}
      AND NOT EXISTS (${newerSql("m", "?5", true)})`,
    id,
    reader.person,
    JSON.stringify(reader.groups),
    lineageOfWriter(writer),
    at
  );
  retired.toArray();
  return retired.rowsWritten > 0 ? "done" : "nothing";
};

/**
 * `?1` the question's telling terms (JSON, words.ts `Term`): the memories
 * that hold any, in any form, with how many they hold so and as written.
 */
const wordsSql = memoriesSql({
  prelude: `found AS MATERIALIZED (
  SELECT memory_words.rowid AS row, asked.key AS term, 1 AS exact
  FROM json_each(?1) AS asked CROSS JOIN memory_words
  WHERE memory_words MATCH asked.value ->> '$.exact'
  UNION ALL
  SELECT memory_words.rowid, asked.key, 0
  FROM json_each(?1) AS asked CROSS JOIN memory_words
  WHERE memory_words MATCH asked.value ->> '$.forms'
  UNION ALL
  SELECT memory_stems.rowid, asked.key, 0
  FROM json_each(?1) AS asked CROSS JOIN memory_stems
  WHERE memory_stems MATCH asked.value ->> '$.forms'
),
matched AS MATERIALIZED (
  SELECT row, count(DISTINCT term) AS words, sum(exact) AS exact
  FROM found GROUP BY row
)`,
  base: "SELECT row FROM matched",
  joins: "\nJOIN matched ON matched.row = m.row",
  columns: ", matched.words AS words, matched.exact AS exact",
  filter: "judged.is_current = 1",
  order: `matched.words DESC, matched.exact DESC, confirmation IS NULL,
  m.learned_at DESC, m.row DESC`,
});

/**
 * A memory the words way found: how many of the question's telling words
 * it holds in any form and as written, and its row and its version's row
 * in this store.
 */
export interface MemoryFound extends Memory {
  words: number;
  exact: number;
  row: number;
  versionRow: number | null;
}

/**
 * The current memories the reader may read, as of `at` (milliseconds),
 * that hold the question's telling words in any form, best first: more
 * of them, then more of them as written, then confirmed, then newer. At
 * most `limit` (`recallLimit` by default). For recall's words way: each
 * memory is scored on its own words alone, never on how often a word is
 * in what the reader may not read. Synchronous, so it reads the same
 * snapshot as the rest of a recall.
 */
export const memoriesByWords = (
  sql: SqlStorage,
  {
    question,
    reader,
    at,
    limit = recallLimit,
  }: { question: string; reader: Reader; at: number; limit?: number }
): MemoryFound[] => {
  const { telling } = termsOf(question);
  if (telling.length === 0) {
    return [];
  }
  return sql
    .exec<MemoryRow & { words: number; exact: number }>(
      wordsSql,
      JSON.stringify(telling),
      reader.person,
      JSON.stringify(reader.groups),
      at,
      limit
    )
    .toArray()
    .map((row) => ({
      ...memoryOf(row),
      words: row.words,
      exact: row.exact,
      row: row.row,
      versionRow: row.version_row,
    }));
};
