import { factSidesShown, versionChangeParts } from "./contract.ts";
import type {
  ChangedEntity,
  ChangedMemory,
  Reader,
  VersionChange,
  VersionChangeCursor,
  VersionChangePart,
} from "./contract.ts";
import { namedOf } from "./entities.ts";
import {
  endedByVersionSql,
  memoriesSql,
  memoryOf,
  memoryRows,
  outOnlySql,
  readableKeysSql,
  retiredSql,
  versionVisibleSql,
  visibleSql,
} from "./memories.ts";
import type { MemoryRow } from "./memories.ts";
import { readableSql } from "./reader-sets.ts";

// What a version of a source changed (contract.ts `readVersionChange`):
// read from what the store already keeps, nothing stored for it. Every
// memory drawn from a source names the version it rests on (`memories`
// `source`, `version`: the change key's source and version), so what a
// version added is those memories; what it ended is the earlier memories
// of its source's lineage whose first ending came from it
// (memories.ts `endedByVersionSql`); and what it made contested is what it
// added that stands contested now, with its rivals. Each statement filters
// by the reader inside itself, as every read of memories does
// (`memoriesSql`), so what they may not read takes no place, ends
// nothing, contests nothing and names nothing.

/** A moment after every stamp: what nothing of a version stands for. */
const afterEverything = Number.MAX_SAFE_INTEGER;

/**
 * `?1` the source, `?6` the version: the version from which an earlier
 * memory can still be this version's to replace (`since`), as the reader
 * sees it as of `?4`: the latest earlier version of the source marked
 * fully extracted that they may read (memories.ts `extractedSql`) and
 * that was written before anything of this version that could replace a
 * memory, since that mark then ended every memory before it first; 0 for a
 * thread, whose marks end nothing, and for a source with no such mark.
 */
const sinceSql = `since AS MATERIALIZED (
  SELECT coalesce((
    SELECT mark.version FROM memory_extractions AS mark
    WHERE mark.source = ?1 AND mark.version < ?6 AND mark.at <= ?4
      -- Written before anything of this version that could replace a
      -- memory (its memories, its own mark), by the store's stamps: a mark
      -- written after (an add may mark any version it holds) ended nothing
      -- before this version did, so it cuts nothing off.
      AND mark.at < min(
        coalesce((
          SELECT min(mine.learned_at) FROM memories AS mine
          WHERE mine.source = ?1 AND mine.version = ?6
        ), ${afterEverything}),
        coalesce((
          SELECT min(own.at) FROM memory_extractions AS own
          WHERE own.source = ?1 AND own.version = ?6
        ), ${afterEverything})
      )
      AND mark.readers IN (${readableKeysSql})
      AND ${versionVisibleSql("mark.source", "mark.version")}
      AND NOT EXISTS (
        SELECT 1 FROM source_subjects AS kept
        WHERE kept.source = ?1 AND kept.thread = 1
      )
    ORDER BY mark.version DESC
    LIMIT 1
  ), 0) AS version
),
-- The first row of the source's memories since then: every one of them is
-- at or after it, so a seek of a lineage's memories starts there.
since_row AS MATERIALIZED (
  SELECT coalesce(min(row), 0) AS row FROM memories
  WHERE source = ?1 AND version >= (SELECT version FROM since)
)`;

/**
 * `?1` the source, `?6` the version: the memories the version may have
 * changed, bounded by what it touched, never the source's whole history:
 * its own; the earlier ones of its source each of its own can end (a
 * newer memory of the lineage, `newerSql`: the same entity and attribute,
 * and for one of many or of none the same value, one seek of
 * `memories_lineage_value_idx` each); when it is marked fully extracted,
 * every earlier one; and while it is its source's current version, judged,
 * its source's out memories (`memory_outs`). Of the earlier ones, those
 * since `since` alone. None when the reader may not read the version.
 * Which of them it changed is decided per reader (`partSql`).
 */
const touchedSql = `
SELECT row FROM (
  SELECT row FROM memories WHERE source = ?1 AND version = ?6
  UNION
  SELECT earlier.row FROM memories AS mine
  CROSS JOIN memories AS earlier
    ON earlier.entity = mine.entity AND earlier.attribute = mine.attribute
    AND earlier.lineage = mine.lineage
    AND earlier.row >= (SELECT row FROM since_row)
  WHERE mine.source = ?1 AND mine.version = ?6 AND mine.one_value = 1
    AND earlier.lineage_order < ?6
    AND earlier.lineage_order >= (SELECT version FROM since)
  UNION
  SELECT earlier.row FROM memories AS mine
  CROSS JOIN memories AS earlier
    ON earlier.entity = mine.entity AND earlier.attribute IS mine.attribute
    AND earlier.lineage = mine.lineage AND earlier.value_key = mine.value_key
    AND earlier.row >= (SELECT row FROM since_row)
  WHERE mine.source = ?1 AND mine.version = ?6 AND mine.one_value = 0
    AND earlier.lineage_order < ?6
    AND earlier.lineage_order >= (SELECT version FROM since)
  UNION
  SELECT row FROM memories
  WHERE source = ?1 AND version < ?6
    AND version >= (SELECT version FROM since)
    AND EXISTS (
      SELECT 1 FROM memory_extractions WHERE source = ?1 AND version = ?6
    )
  UNION
  SELECT gone.row FROM memories AS gone
  CROSS JOIN memory_outs AS out ON out.memory = gone.row
  WHERE gone.source = ?1 AND gone.version < ?6
    AND gone.version >= (SELECT version FROM since)
    AND EXISTS (
      SELECT 1 FROM current_versions AS pointer
      CROSS JOIN source_versions AS current ON current.row = pointer.version_row
      WHERE pointer.source = ?1 AND pointer.judged_row = pointer.version_row
        AND current.version = ?6
    )
)
WHERE ${versionVisibleSql("?1", "?6")}`;

/** The parts of a change, by their place in a page: added, replaced, out. */
const partOrder = { added: 0, ended: 1, out: 2 } as const;

/**
 * Which part of version `?6`'s change the memory `m` is, as the reader
 * sees it: one of the version's own (added); an earlier one it replaced
 * (memories.ts `endedByVersionSql`); while it is current, an earlier one
 * that left only because its text no longer holds its quote
 * (`outOnlySql`); or none.
 */
const partSql = `CASE
  WHEN m.version = ?6 THEN ${partOrder.added}
  WHEN judged.ended_at IS NOT NULL AND ${endedByVersionSql("?6")} THEN ${partOrder.ended}
  WHEN judged.ended_at IS NOT NULL AND ${outOnlySql("?6")} THEN ${partOrder.out}
END`;

/**
 * `?1` the source, `?6` the version, `?7` 1 to go on after the memory
 * whose place is `?8` (its part's order), `?9` (when it was learned) and
 * `?10` (its id): what the version changed, as the reader sees it as of
 * `?4`, by part, then when each was learned, then id; at most `?5`.
 */
const changeSql = memoriesSql({
  prelude: sinceSql,
  base: touchedSql,
  filter: "1",
  order: "part, learned_at, id",
  columns: `, ${partSql} AS part`,
  outer: `SELECT * FROM rows
WHERE part IS NOT NULL
  AND (?7 = 0 OR part > ?8 OR (part = ?8 AND (
    learned_at > ?9 OR (learned_at = ?9 AND id > ?10)
  )))
ORDER BY part, learned_at, id
LIMIT ?5`,
});

/**
 * `?1` the entity's row, `?6` the attribute, `?7` the value's key of the
 * memory asked about: the current memories of that fact the reader may
 * read that say something else, as `readMemories` orders them.
 */
const rivalsSql = memoriesSql({
  base: `SELECT row FROM memories
    WHERE entity = ?1 AND attribute = ?6 AND value_key IS NOT ?7`,
  filter: "judged.is_current = 1",
  order: "confirmation IS NULL, m.learned_at DESC, m.id DESC",
});

/** A memory `m` the reader may read, learned and not retired by `?4`. */
const keptSql = `m.learned_at <= ?4 AND NOT ${retiredSql("m", "?4")} AND ${visibleSql("m")}`;

/** A mention `m` before `first`'s (when learned, then id). */
const beforeSql = `(m.learned_at < first.learned
  OR (m.learned_at = first.learned AND m.id < first.id))`;

/**
 * `?1` the entities' rows (JSON), `?4` the moment read at, `?5` the source
 * and `?6` the version: those whose first memory the reader may read that
 * mentions them (learned and not retired by then; by when it was learned,
 * then its id, as entities.ts stands an entity by its first mention)
 * rests on that version: the version's own first such mention of each,
 * and no such mention before it. Asked as "none before", which stops at
 * the first found, never ordering every mention of an entity mentioned
 * often.
 */
const firstSeenSql = `
WITH ${readableSql},
mentions AS (
  SELECT asked.value AS entity, m.learned_at AS learned, m.id AS id
  FROM json_each(?1) AS asked
  CROSS JOIN memories AS m ON m.source = ?5 AND m.version = ?6
  WHERE (m.entity = asked.value OR m.object = asked.value) AND ${keptSql}
),
first AS (
  SELECT entity, learned, id FROM (
    SELECT entity, learned, id, row_number() OVER (
      PARTITION BY entity ORDER BY learned, id
    ) AS place FROM mentions
  ) WHERE place = 1
)
SELECT first.entity AS entity FROM first
WHERE NOT EXISTS (
    SELECT 1 FROM memories AS m
    WHERE m.entity = first.entity AND ${beforeSql} AND ${keptSql}
  )
  AND NOT EXISTS (
    SELECT 1 FROM memories AS m
    WHERE m.object = first.entity AND ${beforeSql} AND ${keptSql}
  )`;

/** The part of a row of `changeSql`. */
const partOf = (row: MemoryRow): VersionChangePart => {
  const found = versionChangeParts.find((part) => partOrder[part] === row.part);
  if (found === undefined) {
    throw new Error("A memory of a change in no part");
  }
  return found;
};

/** What `readVersionChange` is asked with, checked. */
export interface VersionChangeAsked {
  source: string;
  version: number;
  reader: Reader;
  /** The moment read at: the first page's, carried by its cursor. */
  at: number;
  after?: VersionChangeCursor;
  limit: number;
}

/** The rivals of `row` the reader may read, as of `at`: the first `factSidesShown`, and whether more follow. */
const rivalsOf = (
  sql: SqlStorage,
  row: MemoryRow,
  reader: Reader,
  at: number
): { rivals: MemoryRow[]; more: boolean } => {
  const rows = memoryRows(
    sql,
    rivalsSql,
    row.entity_row,
    reader,
    at,
    factSidesShown + 1,
    row.attribute,
    row.value_key
  );
  return {
    rivals: rows.slice(0, factSidesShown),
    more: rows.length > factSidesShown,
  };
};

/**
 * The entities `rows` name, about or related to, as the reader sees them
 * as of `at` (entities.ts `namedOf`), each marked when the version made
 * it seen (`firstSeenSql`).
 */
const entitiesOf = (
  sql: SqlStorage,
  rows: readonly MemoryRow[],
  { source, version, reader, at }: VersionChangeAsked
): ChangedEntity[] => {
  const ids = [
    ...new Set(
      rows.flatMap(({ about, object }) =>
        object === null ? [about] : [about, object]
      )
    ),
  ];
  if (ids.length === 0) {
    return [];
  }
  const found = sql
    .exec<{ row: number; id: string; kind: string }>(
      `SELECT entities.row AS row, entities.id AS id, entities.kind AS kind
      FROM json_each(?1) AS asked
      CROSS JOIN entities ON entities.id = asked.value
      ORDER BY asked.key`,
      JSON.stringify(ids)
    )
    .toArray();
  const firstSeen = new Set(
    sql
      .exec<{ entity: number }>(
        firstSeenSql,
        JSON.stringify(found.map(({ row }) => row)),
        reader.person,
        JSON.stringify(reader.groups),
        at,
        source,
        version
      )
      .toArray()
      .map(({ entity }) => entity)
  );
  const { entities } = namedOf(sql, found, reader, at);
  return entities.map((entity, index) => ({
    ...entity,
    firstSeen: firstSeen.has(found[index]?.row ?? -1),
  }));
};

/**
 * A page of what a version changed, as the reader sees it (contract.ts
 * `readVersionChange`), or null when they may not read the version: one
 * memory more is read than asked, to tell whether more follow.
 */
export const readVersionChange = (
  sql: SqlStorage,
  asked: VersionChangeAsked
): VersionChange | null => {
  const { source, version, reader, at, after, limit } = asked;
  const visible = sql
    .exec(
      `WITH ${readableSql} SELECT 1 WHERE ${versionVisibleSql("?1", "?4")}`,
      source,
      reader.person,
      JSON.stringify(reader.groups),
      version
    )
    .toArray();
  if (visible.length === 0) {
    return null;
  }
  const rows = memoryRows(
    sql,
    changeSql,
    source,
    reader,
    at,
    limit + 1,
    version,
    after === undefined ? 0 : 1,
    after === undefined ? 0 : partOrder[after.part],
    after?.learnedAt.getTime() ?? 0,
    after?.memory ?? ""
  );
  const page = rows.slice(0, limit);
  const named: MemoryRow[] = [...page];
  const memories = page.map((row): ChangedMemory => {
    const part = partOf(row);
    if (part !== "added" || row.contested !== 1) {
      return { part, memory: memoryOf(row), rivals: [], moreRivals: false };
    }
    const { rivals, more } = rivalsOf(sql, row, reader, at);
    named.push(...rivals);
    return {
      part,
      memory: memoryOf(row),
      rivals: rivals.map(memoryOf),
      moreRivals: more,
    };
  });
  const entities = entitiesOf(sql, named, asked);
  const moment = new Date(at);
  const last = memories.at(-1);
  if (rows.length <= limit || last === undefined) {
    return { memories, entities, at: moment, more: false };
  }
  return {
    memories,
    entities,
    at: moment,
    more: true,
    next: {
      at: moment,
      part: last.part,
      learnedAt: last.memory.learnedAt,
      memory: last.memory.id,
    },
  };
};
