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
 * The conditions under which the memory `alias` is visible to the reader:
 * in its set of readers, and, resting on a version, in that version's and
 * its source's current version's, that version not hidden by an erasure.
 */
export const visibleSql = (alias: string): string => `(
  ${alias}.reader_set IN (SELECT reader_set FROM readable)
  AND (${alias}.version_row IS NULL OR EXISTS (
    SELECT 1 FROM source_versions AS based
    JOIN current_versions ON current_versions.source = based.source
    JOIN source_versions AS current ON current.row = current_versions.version_row
    WHERE based.row = ${alias}.version_row
      AND based.row NOT IN (SELECT version_row FROM erasing_versions)
      AND based.reader_set IN (SELECT reader_set FROM readable)
      AND current.reader_set IN (SELECT reader_set FROM readable)
  ))
)`;

/**
 * The newer memories of `alias`'s lineage that end it, by the order of
 * its lineage (a later version's, or a later row of the same), about the
 * same entity and attribute and, for an attribute of many values, the
 * same value. None for a memory with no attribute. `visible` keeps to
 * those the reader may read.
 */
const newerSql = (alias: string, visible: boolean): string => `
  SELECT newer.learned_at AS at FROM memories AS newer
  WHERE newer.entity = ${alias}.entity
    AND newer.attribute = ${alias}.attribute
    AND newer.lineage = ${alias}.lineage
    AND (${alias}.one_value = 1 OR newer.value_key = ${alias}.value_key)
    AND (newer.lineage_order > ${alias}.lineage_order
      OR (newer.lineage_order = ${alias}.lineage_order AND newer.row > ${alias}.row))
    ${visible ? `AND newer.learned_at <= ?4 AND ${visibleSql("newer")}` : ""}`;

/**
 * When the reader saw `m` stop being believed, as of `?4`: retired then,
 * or ended by a newer memory of its lineage they may read, learned by
 * then; never before it was learned itself (an older version's memory
 * that came late is history from the start). Null while believed.
 */
const endedAtSql = `max(m.learned_at, (SELECT min(at) FROM (
  SELECT m.retired_at AS at WHERE m.retired_at IS NOT NULL AND m.retired_at <= ?4
  UNION ALL${newerSql("m", true)}
)))`;

/** The latest confirmation of `m` the reader may see, as JSON, or null. */
const confirmationSql = `(
  SELECT json_object('by', confirmed.person, 'at', confirmed.at)
  FROM memory_confirmations AS confirmed
  WHERE confirmed.memory = m.row AND confirmed.at <= ?4
    AND NOT EXISTS (
      SELECT 1 FROM memory_confirmed_over AS overruled
      JOIN memories AS other ON other.row = overruled.memory
      WHERE overruled.confirmation = confirmed.row AND NOT ${visibleSql("other")}
    )
  ORDER BY confirmed.at DESC, confirmed.row DESC
  LIMIT 1
)`;

/** A memory as the statements below return it. */
interface MemoryRow extends Record<string, SqlStorageValue> {
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
interface MemoriesQuery {
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
const memoriesSql = ({
  prelude,
  base,
  filter,
  order,
  joins = "",
  columns = "",
}: MemoriesQuery): string => `
WITH ${readableSql},${prelude === undefined ? "" : `\n${prelude},`}
base AS MATERIALIZED (${base}),
candidates AS MATERIALIZED (
  SELECT row FROM base
  UNION
  SELECT partner.row FROM base
  JOIN memories AS asked ON asked.row = base.row AND asked.one_value = 1
  JOIN memories AS partner
    ON partner.entity = asked.entity AND partner.attribute = asked.attribute
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
)
SELECT m.row AS row, m.entity AS entity_row, m.id AS id, about.id AS about,
  m.attribute AS attribute, object.id AS object, m.value AS value,
  m.value_key AS value_key, m.lineage AS lineage, m.type AS type,
  m.statement AS statement, m.quote AS quote, based.source AS source,
  based.version AS version, m.writer AS writer, m.speaker AS speaker,
  m.valid_from AS valid_from, m.valid_until AS valid_until,
  m.learned_at AS learned_at, judged.ended_at AS ended_at,
  judged.is_current AS is_current,
  (judged.is_current = 1 AND m.one_value = 1 AND EXISTS (
    SELECT 1 FROM judged AS other
    JOIN memories AS rival ON rival.row = other.row
    WHERE other.is_current = 1 AND rival.entity = m.entity
      AND rival.attribute = m.attribute AND rival.value_key IS NOT m.value_key
  )) AS contested,
  ${confirmationSql} AS confirmation${columns}
FROM judged
JOIN memories AS m ON m.row = judged.row
JOIN entities AS about ON about.row = m.entity
LEFT JOIN entities AS object ON object.row = m.object
LEFT JOIN source_versions AS based ON based.row = m.version_row${joins}
WHERE judged.row IN (SELECT row FROM base) AND ${filter}
ORDER BY ${order}
LIMIT ?5`;

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
const memoryOf = (row: MemoryRow): Memory => {
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
const memoryRows = (
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

/** The row of the entity `id`, or none. */
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
  base: `SELECT row FROM memories WHERE entity = ?1 AND (?6 IS NULL OR attribute = ?6)
    UNION SELECT row FROM memories WHERE object = ?1 AND (?6 IS NULL OR attribute = ?6)`,
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
 * contested memories of one-value attributes, of the first `?6` facts.
 */
const contestedSql = memoriesSql({
  base: `SELECT row FROM memories
    WHERE one_value = 1 AND attribute IS NOT NULL AND (?1 IS NULL OR entity = ?1)`,
  filter: `judged.is_current = 1 AND contested = 1`,
  order: `m.entity, m.attribute, confirmation IS NULL, m.learned_at DESC, m.row DESC`,
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
  // Every contested memory, then cut to the first `limit` facts: each
  // fact whole, never a fact with some of its sides left out.
  const facts = new Map<string, ContestedFact>();
  for (const row of memoryRows(sql, contestedSql, entityRow, reader, at, -1)) {
    const key = JSON.stringify([row.entity_row, row.attribute]);
    let fact = facts.get(key);
    if (fact === undefined) {
      if (facts.size === limit) {
        break;
      }
      fact = { about: row.about, attribute: row.attribute ?? "", memories: [] };
      facts.set(key, fact);
    }
    fact.memories.push(memoryOf(row));
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
  base: "SELECT row FROM memories WHERE entity = ?1 AND attribute = ?6",
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
    JSON.stringify(over.map((memory) => memory.row))
  );
  return "done";
};

/**
 * Retires the memory `id` if its lineage is `writer`'s and it is still
 * believed: not retired, and no newer memory of its lineage ended it
 * (contract.ts `retireMemory`).
 */
export const retireMemory = (
  sql: SqlStorage,
  { id, writer, at }: { id: string; writer: string; at: number }
): MemoryChangeOutcome => {
  const retired = sql.exec(
    `UPDATE memories AS m SET retired_at = ?3
    WHERE m.id = ?1 AND m.lineage = ?2 AND m.retired_at IS NULL
      AND NOT EXISTS (${newerSql("m", false)})`,
    id,
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
  columns: ", matched.words AS words",
  filter: "judged.is_current = 1",
  order: `matched.words DESC, matched.exact DESC, confirmation IS NULL,
  m.learned_at DESC, m.row DESC`,
});

/** A memory the words way found, with how many of the question's telling words it holds. */
export interface MemoryFound extends Memory {
  words: number;
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
    .exec<MemoryRow & { words: number }>(
      wordsSql,
      JSON.stringify(telling),
      reader.person,
      JSON.stringify(reader.groups),
      at,
      limit
    )
    .toArray()
    .map((row) => ({ ...memoryOf(row), words: row.words }));
};
