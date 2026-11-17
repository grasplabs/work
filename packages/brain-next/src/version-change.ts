import { factSidesShown } from "./contract.ts";
import type {
  ChangedEntity,
  ChangedMemory,
  Reader,
  VersionChange,
  VersionChangeCursor,
} from "./contract.ts";
import { namedOf } from "./entities.ts";
import {
  endedByVersionSql,
  memoriesSql,
  memoryOf,
  memoryRows,
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

/**
 * `?1` the source, `?6` the version, `?7` 1 to go on after the memory
 * whose place is `?8` (0 added, 1 ended), `?9` (when it was learned) and
 * `?10` (its id): the version's memories, then the earlier memories of
 * its source it ended, as the reader sees them as of `?4`; none when they
 * may not read that version. Its cost grows with the source's history:
 * every earlier memory of it is judged.
 */
const changeSql = memoriesSql({
  base: `SELECT row FROM memories
    WHERE source = ?1 AND version <= ?6 AND ${versionVisibleSql("?1", "?6")}`,
  filter: `(m.version = ?6
    OR (judged.ended_at IS NOT NULL AND ${endedByVersionSql("?6")}))
  AND (?7 = 0 OR (m.version < ?6) > ?8 OR ((m.version < ?6) = ?8 AND (
    m.learned_at > ?9 OR (m.learned_at = ?9 AND m.id > ?10)
  )))`,
  order: "(m.version < ?6), m.learned_at, m.id",
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

/**
 * `?1` the entities' rows (JSON), `?4` the moment read at, `?5` the source
 * and `?6` the version: of each, whether the first memory the reader may
 * read that mentions it, learned and not retired by then (by when it was
 * learned, then its id: as entities.ts stands an entity by its first
 * mention), rests on that version.
 */
const firstSeenSql = `
WITH ${readableSql}
SELECT asked.value AS entity, (
  SELECT mention.source IS ?5 AND mention.version IS ?6 FROM (
    SELECT m.source AS source, m.version AS version, m.learned_at AS learned,
      m.id AS id
    FROM memories AS m
    WHERE m.entity = asked.value AND m.learned_at <= ?4
      AND NOT ${retiredSql("m", "?4")} AND ${visibleSql("m")}
    UNION ALL
    SELECT m.source, m.version, m.learned_at, m.id FROM memories AS m
    WHERE m.object = asked.value AND m.learned_at <= ?4
      AND NOT ${retiredSql("m", "?4")} AND ${visibleSql("m")}
  ) AS mention
  ORDER BY mention.learned, mention.id
  LIMIT 1
) AS first_seen
FROM json_each(?1) AS asked`;

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
      .exec<{ entity: number; first_seen: number | null }>(
        firstSeenSql,
        JSON.stringify(found.map(({ row }) => row)),
        reader.person,
        JSON.stringify(reader.groups),
        at,
        source,
        version
      )
      .toArray()
      .flatMap(({ entity, first_seen: first }) => (first === 1 ? [entity] : []))
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
    after?.part === "ended" ? 1 : 0,
    after?.learnedAt.getTime() ?? 0,
    after?.memory ?? ""
  );
  const page = rows.slice(0, limit);
  const named: MemoryRow[] = [...page];
  const memories = page.map((row): ChangedMemory => {
    const part = row.version === version ? "added" : "ended";
    if (part === "ended" || row.contested !== 1) {
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
