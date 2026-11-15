import { z } from "zod";

import {
  factSidesShown,
  memoryTypes,
  recallLimit,
  speakerSchema,
} from "./contract.ts";
import type {
  ContestedCursor,
  ContestedFact,
  ContestedPage,
  MemoriesCursor,
  MemoriesRead,
  EntityId,
  Memory,
  MemoryChangeOutcome,
  MemoryId,
  PersonReader,
  Reader,
  RetiredMemory,
  SourceVersionRef,
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
// `?3` their groups), the moment what the store learned is read at `?4`
// (milliseconds: the read's moment, or an earlier one asked), the moment
// the dates a fact is true are judged at `?20` (`validSql`: when unbound,
// `?4`), and the limit at `?5`.

/**
 * Whether the reader may read version `version` of the source `source`
 * (expressions): among its readers and its source's current version's,
 * and no erasure hides it. A version no longer stored is read by no one.
 */
const versionVisibleSql = (source: string, version: string): string => `EXISTS (
    SELECT 1 FROM source_versions AS based
    JOIN current_versions ON current_versions.source = based.source
    JOIN source_versions AS current ON current.row = current_versions.version_row
    WHERE based.source = ${source} AND based.version = ${version}
      AND based.row NOT IN (SELECT version_row FROM erasing_versions)
      AND based.reader_set IN (SELECT reader_set FROM readable)
      AND current.reader_set IN (SELECT reader_set FROM readable)
  )`;

/**
 * The keys of the sets of readers the reader is in (`reader_sets.key`):
 * what memories and extraction marks name their readers by. A key whose
 * set is no longer stored matches no one.
 */
const readableKeysSql = `SELECT key FROM reader_sets
    WHERE id IN (SELECT reader_set FROM readable)`;

/**
 * Whether the row `erasure` of `erasures` is an erasure of the writer
 * whose lineage's SHA-256 is `subject` made after the moment `at` (SQL
 * expressions): one seek of `erasures_writer_idx`, however often the
 * writer was erased. The one rule of what a writer's erasure covers.
 */
export const writerErasedAfterSql = (
  erasure: string,
  subject: string,
  at: string
): string =>
  `(${erasure}.kind = 'writer' AND ${erasure}.subject = ${subject}
    AND ${erasure}.erased_at > ${at})`;

/** Whether the row `erasure` of `erasures` covers the memory `memory` (`writerErasedAfterSql`). */
export const erasedBySql = (memory: string, erasure: string): string =>
  writerErasedAfterSql(
    erasure,
    `${memory}.writer_subject`,
    `${memory}.learned_at`
  );

/**
 * Whether no erasure of the memory `alias`'s writer came after it was
 * learned (erasure.ts `eraseWriter`): a writer's erasure hides, from the
 * statement that records it on, every memory of that writer learned
 * before it, until the tick deletes them, also those a restore of an older
 * copy brings back; what the writer adds afterwards is learned after it.
 * Asked of every memory a statement may read, count, link or export.
 */
export const unerasedSql = (alias: string): string => `(
  ${alias}.writer_subject IS NULL OR NOT EXISTS (
    SELECT 1 FROM erasures AS gone WHERE ${erasedBySql(alias, "gone")}
  )
)`;

/**
 * The conditions under which the memory `alias` is visible to the reader:
 * in its set of readers, and, resting on a version, in that version's and
 * its source's current version's, that version not hidden by an erasure;
 * and no erasure of its writer since it was learned (`unerasedSql`).
 */
export const visibleSql = (alias: string): string => `(
  ${alias}.readers IN (${readableKeysSql})
  AND (${alias}.source IS NULL
    OR ${versionVisibleSql(`${alias}.source`, `${alias}.version`)})
  AND ${unerasedSql(alias)}
)`;

/**
 * Whether the memory `alias` was retired by its writer by the moment `at`
 * (an expression, milliseconds). A retired memory stays history, read
 * where history is asked for (`readMemories` with `history`), and gives
 * nothing to any other read: no name, no match of a name or identifier
 * asked, no mention that makes its entity seen (entities.ts), so nothing
 * those reads answer rests on a memory every pin check withholds
 * (`readableMemories`).
 */
export const retiredSql = (alias: string, at: string): string =>
  `(${alias}.retired_at IS NOT NULL AND ${alias}.retired_at <= ${at})`;

/**
 * The moment the dates a fact is true are judged at: `?20`, a read as of a
 * moment ahead of what the store learned; else `?4`, the moment what the
 * store learned is read at. A statement that binds no `?20` judges both
 * at `?4`.
 */
const validSql = "coalesce(?20, ?4)";

/** When a memory starts to count: when it was learned, or its world start if later. */
const startSql = (alias: string): string =>
  `max(${alias}.learned_at, coalesce(${alias}.valid_from, ${alias}.learned_at))`;

/**
 * The newer memories of `alias`'s lineage that end it, by the order of
 * its lineage (a later version's, or a later row of the same), about the
 * same entity and attribute and, for an attribute of many values, the
 * same value, each learned by `learned` and started by `valid` (its world
 * start, or when it was learned), and not retired by `learned`: a retired memory ends nothing, so forgetting a newer
 * value makes the one before current again. None for a memory with no
 * attribute. `visible` keeps to those the reader may read.
 */
const newerSql = (
  alias: string,
  learned: string,
  valid: string,
  visible: boolean
): string => {
  // Two seeks, one for each kind of attribute, never an OR between them:
  // an OR kept `value_key` out of the index (`memories_lineage_value_idx`),
  // so a memory of many values read every memory of its lineage.
  const rest = `
    AND (newer.lineage_order > ${alias}.lineage_order
      OR (newer.lineage_order = ${alias}.lineage_order AND newer.row > ${alias}.row))
    AND newer.learned_at <= ${learned}
    AND ${startSql("newer")} <= ${valid}
    AND (newer.retired_at IS NULL OR newer.retired_at > ${learned})
    ${visible ? `AND ${visibleSql("newer")}` : ""}`;
  return `
  SELECT ${startSql("newer")} AS at FROM memories AS newer
  WHERE ${alias}.one_value = 1
    AND newer.entity = ${alias}.entity
    AND newer.attribute = ${alias}.attribute
    AND newer.lineage = ${alias}.lineage${rest}
  UNION ALL
  SELECT ${startSql("newer")} AS at FROM memories AS newer
  WHERE ${alias}.one_value = 0
    AND newer.entity = ${alias}.entity
    AND newer.attribute = ${alias}.attribute
    AND newer.lineage = ${alias}.lineage
    AND newer.value_key = ${alias}.value_key${rest}`;
};

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
    AND extracted.readers IN (${readableKeysSql})
    AND ${versionVisibleSql("extracted.source", "extracted.version")}`;

/**
 * When the reader saw `m` stop being believed, as of `?4`: retired then,
 * or ended by a newer memory of its lineage they may read, from its
 * start, or by a later version of its source marked fully extracted;
 * never before it was learned itself (an older version's memory that came
 * late is history from the start). Null while believed.
 */
export const endedAtSql = `max(m.learned_at, (SELECT min(at) FROM (
  SELECT m.retired_at AS at WHERE m.retired_at IS NOT NULL AND m.retired_at <= ?4
  UNION ALL${newerSql("m", "?4", validSql, true)}
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
 * The latest confirmation of `m` that counts for the reader, as JSON (its
 * row too, for what it rests on), or null: one made over memories they
 * may all read, and over every current rival they may read, so one made
 * without seeing a rival never ranks first for a reader who sees it. A
 * memory it was made over that its writer retired since still decides
 * this by whether the reader may read it: a reader who never could learns
 * nothing from its retirement.
 */
const confirmationSql = `(
  SELECT json_object('by', confirmed.person, 'at', confirmed.at, 'row', confirmed.row)
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
  CROSS JOIN memories AS asked ON asked.row = base.row AND asked.one_value = 1
  CROSS JOIN memories AS partner
    ON partner.attribute = asked.attribute
    AND partner.entity = asked.entity
),
seen AS MATERIALIZED (
  SELECT m.row AS row, ${endedAtSql} AS ended_at
  FROM candidates
  CROSS JOIN memories AS m ON m.row = candidates.row
  WHERE m.learned_at <= ?4 AND ${visibleSql("m")}
),
judged AS MATERIALIZED (
  SELECT seen.row AS row, seen.ended_at AS ended_at,
    (seen.ended_at IS NULL
      AND (m.valid_from IS NULL OR m.valid_from <= ${validSql})
      AND (m.valid_until IS NULL OR m.valid_until > ${validSql})) AS is_current
  FROM seen CROSS JOIN memories AS m ON m.row = seen.row
)`;
  const select = `
SELECT m.row AS row, about.row AS entity_row, m.id AS id, about.id AS about,
  m.attribute AS attribute, object.id AS object, m.value AS value,
  m.value_key AS value_key, m.lineage AS lineage, m.type AS type,
  m.statement AS statement, m.quote AS quote, m.source AS source,
  m.version AS version, m.writer AS writer, m.speaker AS speaker,
  m.valid_from AS valid_from, m.valid_until AS valid_until,
  m.learned_at AS learned_at, judged.ended_at AS ended_at,
  judged.is_current AS is_current,
  (judged.is_current = 1 AND EXISTS (${rivalSql})) AS contested,
  ${confirmationSql} AS confirmation${columns}
FROM judged
JOIN memories AS m ON m.row = judged.row
JOIN entities AS about ON about.row = m.entity
LEFT JOIN entities AS object ON object.row = m.object${joins}
WHERE judged.row IN (SELECT row FROM base) AND ${filter}`;
  return outer === undefined
    ? `${tables}${select}\nORDER BY ${order}\nLIMIT ?5`
    : `${tables},\nrows AS (${select}\n)\n${outer}`;
};

/** The latest stamp a write was given, or 0 before the first. */
const latestStamp = (sql: SqlStorage): number =>
  sql
    .exec<{ latest: number }>("SELECT latest FROM memory_stamps WHERE id = 1")
    .toArray()
    .at(0)?.latest ?? 0;

/** The stamp the next write gets (`stampWrite`), not yet kept. */
export const nextStamp = (sql: SqlStorage): number =>
  Math.max(Date.now(), latestStamp(sql)) + 1;

/** `stamp` kept as the latest a write was given. */
const keepStamp = (sql: SqlStorage, stamp: number): void => {
  sql.exec(
    `INSERT INTO memory_stamps (id, latest) VALUES (1, ?1)
    ON CONFLICT (id) DO UPDATE SET latest = ?1`,
    stamp
  );
};

/**
 * Stamps a write of memories (an add's memories, a confirmation, a
 * retire, an extraction mark), in the caller's transaction: after now, and
 * after every stamp before it (`memory_stamps`), so a read given a moment
 * (`readMoment`) never sees a write made after it, in its own millisecond
 * too, and sees every write made before it. Ahead of the real clock by
 * at most 1 ms plus the number of writes in the current millisecond.
 */
export const stampWrite = (sql: SqlStorage): number => {
  const stamp = nextStamp(sql);
  keepStamp(sql, stamp);
  return stamp;
};

/**
 * Keeps `at` as the latest stamp if it is later, in the caller's
 * transaction: a writer's erasure (erasure.ts), so every write after it,
 * also after a replay of it into an older copy of the store, is stamped
 * after it. Never lowers it.
 */
export const raiseStamp = (sql: SqlStorage, at: number): void => {
  if (at > latestStamp(sql)) {
    keepStamp(sql, at);
  }
};

/**
 * The moment a read of now is given: now, or the latest stamp if later,
 * so it sees every write made before it; what its cursor carries. If the
 * clock goes back, reads keep to the latest stamp until it catches up:
 * `learnedAt` can then be ahead of the clock, and the dates a fact is
 * true are judged at that moment, so one valid a little longer can read
 * as ended until the clock is past it.
 */
export const readMoment = (sql: SqlStorage): number =>
  Math.max(Date.now(), latestStamp(sql));

/** The lineage of a writer's memories. */
export const lineageOfWriter = (writer: string): string => `writer:${writer}`;

/** The lineage of the memories drawn from a source, every version of it. */
export const lineageOfSource = (source: string): string => `source:${source}`;

/** A date of a memory, from its milliseconds. */
const dateOf = (at: number | null): Date | null =>
  at === null ? null : new Date(at);

/** A confirmation as `confirmationSql` builds it. */
const confirmationSchema = z.strictObject({
  by: z.string(),
  at: z.number(),
  row: z.number(),
});

/** A memory's type as stored. */
const memoryTypeSchema = z.enum(memoryTypes);

/** A confirmation as `confirmationSql` gives it, or none. */
const confirmationOf = (
  json: string | null
): { by: string; at: number; row: number } | null => {
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

/** Most bindings before `?20` (`validSql`): `?6` to `?19`. */
const bindingsBeforeValid = 14;

/**
 * As `memoryRows`, with the moment the dates a fact is true are judged at
 * (`?20`), when not `at`.
 */
const memoryRowsAt = (
  sql: SqlStorage,
  statement: string,
  valid: number | null,
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
      ...rest,
      ...Array.from<null>({ length: bindingsBeforeValid - rest.length }).fill(
        null
      ),
      valid
    )
    .toArray();

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
  memoryRowsAt(sql, statement, null, first, reader, at, limit, ...rest);

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
const aboutOrder = `m.attribute IS NULL, coalesce(m.attribute, ''),
  confirmation IS NULL, m.learned_at DESC, m.id DESC`;

/**
 * `?1` the entity's row, `?6` the attribute or null, `?7` 1 for history
 * too, `?8` 1 to go on after a page, ending at the memory whose place in
 * `aboutOrder` is `?9` (no attribute), `?10` (its attribute, or ''),
 * `?11` (not confirmed), `?12` (learned) and `?13` (its id): the memories
 * about the entity, as subject or as what a relation relates to; of one
 * attribute, as subject only, so a contested fact's sides are exactly
 * its entity's current memories of it.
 */
const aboutSql = memoriesSql({
  base: `SELECT row FROM memories
    WHERE entity = ?1 AND (?6 IS NULL OR attribute = ?6)
    UNION SELECT row FROM memories WHERE object = ?1 AND ?6 IS NULL`,
  filter: `(?7 = 1 OR judged.is_current = 1)
  AND (?8 = 0 OR (m.attribute IS NULL) > ?9 OR ((m.attribute IS NULL) = ?9 AND (
    coalesce(m.attribute, '') > ?10 OR (coalesce(m.attribute, '') = ?10 AND (
      (confirmation IS NULL) > ?11 OR ((confirmation IS NULL) = ?11 AND (
        m.learned_at < ?12 OR (m.learned_at = ?12 AND m.id < ?13)
      ))
    ))
  )))`,
  order: aboutOrder,
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

/** What reads of memories are asked with. */
export interface MemoriesAsked {
  entity: EntityId;
  reader: Reader;
  attribute?: string;
  at: number;
  /** The moment the next page's cursor carries (store.ts `#pageMoments`). */
  cursorAt: number;
  /** The moment what the store learned is read at: `at`, or earlier. */
  learned: number;
  history: boolean;
  after?: MemoriesCursor;
  limit: number;
}

/**
 * A page of the memories about an entity the reader may read (contract.ts
 * `readMemories`): one more is read than asked, to tell whether more
 * follow.
 */
const readMemoryRows = (
  sql: SqlStorage,
  {
    entity,
    reader,
    attribute,
    at,
    cursorAt,
    learned,
    history,
    after,
    limit,
  }: MemoriesAsked
): {
  read: MemoriesRead;
  rows: MemoryRow[];
  limit: number;
  reader: Reader;
  at: number;
  learned: number;
} => {
  const found = entityRowOf(sql, entity);
  if (found === undefined) {
    return {
      read: { memories: [], more: false },
      rows: [],
      limit,
      reader,
      at,
      learned,
    };
  }
  const rows = memoryRowsAt(
    sql,
    aboutSql,
    at,
    found.row,
    reader,
    learned,
    limit + 1,
    attribute ?? null,
    history ? 1 : 0,
    after === undefined ? 0 : 1,
    after?.attribute === null ? 1 : 0,
    after?.attribute ?? "",
    after?.confirmed === true ? 0 : 1,
    after?.learnedAt.getTime() ?? 0,
    after?.memory ?? ""
  );
  const memories = rows.slice(0, limit).map(memoryOf);
  const last = memories.at(-1);
  const read: MemoriesRead =
    rows.length <= limit || last === undefined
      ? { memories, more: false }
      : {
          memories,
          more: true,
          next: {
            at: new Date(cursorAt),
            learned: new Date(learned),
            attribute: last.attribute,
            confirmed: last.confirmed !== null,
            learnedAt: last.learnedAt,
            memory: last.id,
          },
        };
  return { read, rows, limit, reader, at, learned };
};

/** `readMemories`, as the contract answers it. */
export const readMemories = (
  sql: SqlStorage,
  asked: MemoriesAsked
): MemoriesRead => readMemoryRows(sql, asked).read;

/**
 * A memory an answer rests on, as a statement finds it: the version of a
 * source it rests on, or, in a writer's word (`source` null), itself.
 */
export interface HeldMemory {
  source: string | null;
  version: number | null;
  memory: string;
}

/**
 * What an answer rests on (contract.ts `Card.restsOn`, `restsOnWords`):
 * of `held`, each version of a source once, and each memory in a writer's
 * word once, by id.
 */
export const restingOn = (
  held: readonly HeldMemory[]
): { restsOn: SourceVersionRef[]; restsOnWords: MemoryId[] } => ({
  restsOn: [
    ...new Map(
      held.flatMap(({ source, version }) =>
        source === null || version === null
          ? []
          : [[JSON.stringify([source, version]), { source, version }] as const]
      )
    ).values(),
  ],
  restsOnWords: [
    ...new Set(
      held.flatMap(({ source, memory }) => (source === null ? [memory] : []))
    ),
  ],
});

/** `row`, as what an answer rests on. */
const heldOfRow = ({ source, version, id }: MemoryRow): HeldMemory => ({
  source,
  version,
  memory: id,
});

/**
 * `?1` the confirmations' rows (JSON), `?2` the moment read at: the
 * memories each was made over, but those their writer retired by then,
 * which an answer rests on no more (a forgotten memory gives nothing to a
 * read but history, `retiredSql`). Whether the confirmation counts still
 * turns on whether the reader may read each (`confirmationSql`), so a
 * reader who loses access to a retired one later keeps an earlier read
 * that says it was confirmed (Known on #2261).
 */
const overruledSql = `
SELECT DISTINCT m.source AS source, m.version AS version, m.id AS memory
FROM json_each(?1) AS asked
CROSS JOIN memory_confirmed_over AS over ON over.confirmation = asked.value
CROSS JOIN memories AS m ON m.row = over.memory
WHERE NOT ${retiredSql("m", "?2")}`;

/**
 * `readMemories`, with every memory what the page says rests on
 * (contract.ts `Card.restsOn`, `restsOnWords`): its memories; each
 * contested one's current rivals, judged as the page was; the memories
 * each counted confirmation was made over; and the memory past the page
 * (`more`).
 */
export const readMemoriesHeld = (
  sql: SqlStorage,
  asked: MemoriesAsked
): { read: MemoriesRead; held: HeldMemory[] } => {
  const { read, rows, limit, reader, at, learned } = readMemoryRows(sql, asked);
  const page = rows.slice(0, limit);
  // The current memories of each entity (the memory's own: a relation's
  // subject, whichever side the card is on) and attribute a contested
  // memory of the page has, read once however many of them it holds.
  const current = new Map<string, MemoryRow[]>();
  const currentOf = (entityRow: number, attribute: string): MemoryRow[] => {
    const key = JSON.stringify([entityRow, attribute]);
    const memories =
      current.get(key) ??
      memoryRowsAt(
        sql,
        currentOfAttributeSql,
        at,
        entityRow,
        reader,
        learned,
        -1,
        attribute
      );
    current.set(key, memories);
    return memories;
  };
  const rivals = page.flatMap((row) =>
    row.contested === 1 && row.attribute !== null
      ? currentOf(row.entity_row, row.attribute).filter(
          ({ value_key: key }) => key !== row.value_key
        )
      : []
  );
  const confirmations = page.flatMap(
    (row) => confirmationOf(row.confirmation)?.row ?? []
  );
  const overruled =
    confirmations.length === 0
      ? []
      : sql
          .exec<{
            source: string | null;
            version: number | null;
            memory: string;
          }>(overruledSql, JSON.stringify(confirmations), learned)
          .toArray()
          .map(({ source, version, memory }) => ({ source, version, memory }));
  return {
    read,
    held: [
      // The page's memories, and the one past it.
      ...rows.map((row) => heldOfRow(row)),
      ...rivals.map((row) => heldOfRow(row)),
      ...overruled,
    ],
  };
};

/**
 * `?1` the entity's row or null, `?6` the most facts, `?7` 1 to go on
 * after the fact whose place is `?8` (when its first memory the reader
 * may read was learned), `?9` (its entity's id) and `?10` (its
 * attribute), `?11` the most sides of a fact to give: the current,
 * contested memories of one-value attributes, of the facts in that order,
 * so where a fact stands, and whether it is listed, depends on nothing
 * hidden; each fact's first `?11` sides in `readMemories`' order.
 */
// Its cost: without an entity, every current one-value memory the reader
// may read is judged (with its ending and its rivals) before the facts
// are ranked and cut, so it grows with the store, not with the page. No
// cheap bound keeps the answer exact: a fact's first readable memory may
// be any of them. Measure before a client's scale; an entity narrows it
// to that entity's memories.
const contestedSql = memoriesSql({
  base: `SELECT row FROM memories
    WHERE one_value = 1 AND attribute IS NOT NULL
      AND (?1 IS NULL OR entity = ?1)`,
  filter: `judged.is_current = 1 AND contested = 1`,
  order: "m.row",
  outer: `,
facts AS (
  SELECT entity_row, about, attribute, min(learned_at) AS first FROM rows
  GROUP BY entity_row, attribute
),
page AS (
  SELECT * FROM facts
  WHERE ?7 = 0 OR first > ?8 OR (first = ?8 AND (
    about > ?9 OR (about = ?9 AND attribute > ?10)
  ))
  ORDER BY first, about, attribute
  LIMIT ?6
)
SELECT * FROM (
  SELECT rows.*, page.first AS fact_first,
    row_number() OVER (
      PARTITION BY rows.entity_row, rows.attribute
      ORDER BY rows.confirmation IS NULL, rows.learned_at DESC, rows.id DESC
    ) AS side
  FROM rows
  JOIN page ON page.entity_row = rows.entity_row AND page.attribute = rows.attribute
)
WHERE side <= ?11
ORDER BY fact_first, about, attribute, side`,
});

/**
 * `?1` the memory ids asked about (JSON), `?2` and `?3` the reader
 * (`readableSql`), `?4` the moment: the ids of those learned by then that
 * the reader may read (`visibleSql`, as every read decides it) and that
 * their writer had not retired by then, a seek by id each. Whether a
 * newer memory ended one, or its time is over, is not asked: a memory
 * once recalled stays as readable as a passage of an older version does.
 */
const readableMemoriesSql = `
WITH ${readableSql}
SELECT m.id AS id FROM json_each(?1) AS asked
CROSS JOIN memories AS m ON m.id = asked.value
WHERE m.learned_at <= ?4
  AND (m.retired_at IS NULL OR m.retired_at > ?4)
  AND ${visibleSql("m")}`;

/**
 * Of `memories`, those the reader may read now and their writer has not
 * retired (contract.ts `readableMemories`), in the order asked, each once.
 */
export const readableMemories = (
  sql: SqlStorage,
  { memories, reader }: { memories: readonly MemoryId[]; reader: Reader }
): MemoryId[] => {
  const asked = [...new Set(memories)];
  if (asked.length === 0) {
    return [];
  }
  const readable = new Set(
    sql
      .exec<{ id: string }>(
        readableMemoriesSql,
        JSON.stringify(asked),
        reader.person,
        JSON.stringify(reader.groups),
        readMoment(sql)
      )
      .toArray()
      .map(({ id }) => id)
  );
  return asked.filter((id) => readable.has(id));
};

/**
 * A page of the contested facts the reader may read (contract.ts
 * `listContested`), each whole: one fact more is read than asked, to tell
 * whether more follow.
 */
export const listContested = (
  sql: SqlStorage,
  {
    entity,
    reader,
    at,
    cursorAt,
    after,
    limit,
  }: {
    entity?: EntityId;
    reader: Reader;
    at: number;
    cursorAt: number;
    after?: ContestedCursor;
    limit: number;
  }
): ContestedPage => {
  let entityRow: number | null = null;
  if (entity !== undefined) {
    const found = entityRowOf(sql, entity);
    if (found === undefined) {
      return { facts: [], at: new Date(cursorAt), more: false };
    }
    entityRow = found.row;
  }
  const facts = new Map<string, ContestedFact & { first: number }>();
  for (const row of memoryRows(
    sql,
    contestedSql,
    entityRow,
    reader,
    at,
    -1,
    limit + 1,
    after === undefined ? 0 : 1,
    after?.learnedAt.getTime() ?? 0,
    after?.entity ?? "",
    after?.attribute ?? "",
    factSidesShown + 1
  )) {
    const key = JSON.stringify([row.entity_row, row.attribute]);
    const fact = facts.get(key) ?? {
      about: row.about,
      attribute: row.attribute ?? "",
      memories: [],
      more: false,
      first: Number(row.fact_first),
    };
    if (fact.memories.length < factSidesShown) {
      fact.memories.push(memoryOf(row));
    } else {
      fact.more = true;
    }
    facts.set(key, fact);
  }
  const all = [...facts.values()];
  const page = all
    .slice(0, limit)
    .map(({ about, attribute, memories, more }) => ({
      about,
      attribute,
      memories,
      more,
    }));
  const moment = new Date(cursorAt);
  const last = all.at(limit - 1);
  if (all.length <= limit || last === undefined) {
    return { facts: page, at: moment, more: false };
  }
  return {
    facts: page,
    at: moment,
    more: true,
    next: {
      at: moment,
      learnedAt: new Date(last.first),
      entity: last.about,
      attribute: last.attribute,
    },
  };
};

/** `?1` the memory's id: that memory, if current for the reader. */
const currentOneSql = memoriesSql({
  base: "SELECT row FROM memories WHERE id = ?1",
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
  { id, reader }: { id: string; reader: PersonReader }
): MemoryChangeOutcome => {
  const at = readMoment(sql);
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
      stampWrite(sql)
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
 * Retires the memory `id` if its lineage is `writer`'s own, the reader may
 * read it, it is not retired, and it is in its world time now: current, or
 * ended by a newer memory of its lineage, which a writer forgets as well,
 * so it never becomes current again when the newer one is retired too.
 * Answers when it was retired and by which change (`change`, kept with
 * it), as recorded: one this writer already retired answers its recorded
 * time and change again, never new ones, whatever change the call names,
 * so a retry answers what the first try did and another call learns it
 * wasn't the one (contract.ts `retireMemory`). Null alike
 * for no such memory, another writer's (retired or not), one the reader
 * may not read and one that expired before it was retired.
 */
export const retireMemory = (
  sql: SqlStorage,
  {
    id,
    reader,
    writer,
    change,
  }: { id: string; reader: Reader; writer: string; change: string }
): RetiredMemory | null => {
  const asked = [
    id,
    reader.person,
    JSON.stringify(reader.groups),
    lineageOfWriter(writer),
    readMoment(sql),
  ];
  const stamp = nextStamp(sql);
  const [retired] = sql
    .exec<{ retired_at: number; retired_change: string | null }>(
      `WITH ${readableSql}
      UPDATE memories AS m SET retired_at = ?6, retired_change = ?7
      WHERE m.id = ?1 AND m.lineage = ?4 AND m.retired_at IS NULL
        AND (m.valid_from IS NULL OR m.valid_from <= ?5)
        AND (m.valid_until IS NULL OR m.valid_until > ?5)
        AND ${visibleSql("m")}
      RETURNING retired_at, retired_change`,
      ...asked,
      stamp,
      change
    )
    .toArray();
  if (retired !== undefined) {
    keepStamp(sql, stamp);
    return {
      retiredAt: new Date(retired.retired_at),
      change: retired.retired_change,
    };
  }
  // Retired already, by this writer, and the reader may read it: a retry
  // or another call, answered with the time and change recorded then.
  const [again] = sql
    .exec<{ retired_at: number; retired_change: string | null }>(
      `WITH ${readableSql}
      SELECT m.retired_at, m.retired_change FROM memories AS m
      WHERE m.id = ?1 AND m.lineage = ?4 AND m.retired_at <= ?5
        AND ${visibleSql("m")}`,
      ...asked
    )
    .toArray();
  return again === undefined
    ? null
    : { retiredAt: new Date(again.retired_at), change: again.retired_change };
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
  m.learned_at DESC, m.id DESC`,
});

/**
 * A memory the words way found: how many of the question's telling words
 * it holds in any form, and how many as written.
 */
export interface MemoryFound extends Memory {
  words: number;
  exact: number;
}

/**
 * The current memories the reader may read, as of `at` (milliseconds),
 * that hold the question's telling words in any form, best first: more
 * of them, then more of them as written, then confirmed, then newer. At
 * most `limit` (`recallLimit` by default). For recall's words way: each
 * memory is scored on its own words alone, never on how often a word is
 * in what the reader may not read. Synchronous, so it reads the same
 * snapshot as the rest of a recall. It takes one moment, `at`: what the
 * store learned and the dates a fact is true are judged at the same one.
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
  return memoryRowsAt(
    sql,
    wordsSql,
    null,
    JSON.stringify(telling),
    reader,
    at,
    limit
  ).map((row) => ({
    ...memoryOf(row),
    words: Number(row.words),
    exact: Number(row.exact),
  }));
};
