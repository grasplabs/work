import { z } from "zod";

import { entityKinds } from "./contract.ts";
import type {
  EntitiesCursor,
  Entity,
  EntityNamesCursor,
  EntityNamesPage,
  EntityPage,
  EntityId,
  EntityKind,
  Identifier,
  Reader,
} from "./contract.ts";
import { visibleSql } from "./memories.ts";
import { readableSql } from "./reader-sets.ts";
import { foldForSearch } from "./words.ts";

// Entities (contract.ts "Memories and entities"): the things memories are
// about, each with the store's own id and kind. Its names and identifiers
// are kept as each memory gave them (`entity_names`), so a name is seen
// only by those who may read a memory that gave it, and an entity only by
// those who may read a memory that mentions it, as its subject or as what
// a relation relates to. Checked inside every statement, before anything
// is capped.
//
// An add links an entity on exact identifiers alone, never on a name: the
// first entity of the same kind holding one (`linkedBy`). Linking by name
// and proposals of likely matches are the linker's (GRA-1740).

/** An entity's kind as stored. */
const kindSchema = z.enum(entityKinds);

/** A name's type as stored. */
const nameTypeSchema = z.enum(["name", "email", "ref"]);

/** Runs of white space, as one. */
const spaces = /\s+/gu;

/** A name as a find compares it: folded as search folds words, its spaces as one. */
export const foldName = (name: string): string =>
  foldForSearch(name).replaceAll(spaces, " ").trim();

/**
 * An identifier as it is compared: an email without case, a reference as
 * written.
 */
export const foldIdentifier = ({ type, value }: Identifier): string =>
  type === "email" ? value.toLowerCase() : value;

/**
 * An entity the reader may see: a memory they may read mentions it.
 */
const mentionedSql = (entity: string): string => `(
  EXISTS (SELECT 1 FROM memories AS m
    WHERE m.entity = ${entity} AND ${visibleSql("m")})
  OR EXISTS (SELECT 1 FROM memories AS m
    WHERE m.object = ${entity} AND ${visibleSql("m")})
)`;

/**
 * Whether the memory `alias` is read by exactly the set of readers whose
 * key (`reader_sets.key`) is `?3`:
 * its own set is it, and, resting on a version, so are the version's and
 * its source's current version's, the version not hidden by an erasure.
 * So everyone who may read an add with those readers may read it too.
 */
const coveredSql = (alias: string): string => `(
  ${alias}.readers = ?3
  AND (${alias}.source IS NULL OR EXISTS (
    SELECT 1 FROM source_versions AS based
    JOIN current_versions ON current_versions.source = based.source
    JOIN source_versions AS current ON current.row = current_versions.version_row
    JOIN reader_sets AS based_set ON based_set.id = based.reader_set
    JOIN reader_sets AS current_set ON current_set.id = current.reader_set
    WHERE based.source = ${alias}.source AND based.version = ${alias}.version
      AND based.row NOT IN (SELECT version_row FROM erasing_versions)
      AND based_set.key = ?3 AND current_set.key = ?3
  ))
)`;

/**
 * The first entity of `kind` holding one of `identifiers` by a memory
 * read by exactly the readers whose set's key is `readers` (`coveredSql`): what an add with those readers links to. An
 * identifier only a memory others read gave links nothing, so no add
 * learns that two identifiers are one entity through a memory its readers
 * may not read: it makes a new entity, and joining the two is a person's
 * or the linker's to propose (GRA-1740).
 */
export const linkedBy = (
  sql: SqlStorage,
  kind: EntityKind,
  identifiers: readonly Identifier[],
  readers: string
): number | undefined => {
  if (identifiers.length === 0) {
    return undefined;
  }
  const [found] = sql
    .exec<{ row: number | null }>(
      `SELECT min(entities.row) AS row
      FROM json_each(?2) AS asked
      JOIN entity_names
        ON entity_names.type = asked.value ->> 0
        AND entity_names.folded = asked.value ->> 1
      JOIN memories AS m ON m.row = entity_names.memory
      JOIN entities ON entities.row = entity_names.entity
      WHERE entities.kind = ?1 AND ${coveredSql("m")}`,
      kind,
      JSON.stringify(identifiers.map((id) => [id.type, foldIdentifier(id)])),
      readers
    )
    .toArray();
  return found?.row ?? undefined;
};

/**
 * Whether an add may name the entity at `entity` by its id: `reader` may see it, or, with no reader, a memory
 * read by exactly the add's readers (their set's key, `readers`) mentions it.
 */
export const mayName = (
  sql: SqlStorage,
  entity: number,
  readers: string,
  reader: Reader | undefined
): boolean => {
  if (reader !== undefined) {
    return (
      sql
        .exec(
          `WITH ${readableSql} SELECT 1 WHERE ${mentionedSql("?1")}`,
          entity,
          reader.person,
          JSON.stringify(reader.groups)
        )
        .toArray().length > 0
    );
  }
  return (
    sql
      .exec(
        `SELECT 1 FROM memories AS m
        WHERE (m.entity = ?1 OR m.object = ?1)
          AND ${coveredSql("m")}
        LIMIT 1`,
        entity,
        null,
        readers
      )
      .toArray().length > 0
  );
};

/** Keeps `names` and `identifiers` of the entity at `entity` as the memory at `memory` gave them. */
export const keepNames = (
  sql: SqlStorage,
  entity: number,
  memory: number,
  names: readonly string[],
  identifiers: readonly Identifier[]
): void => {
  const rows = [
    ...names.map((name) => ["name", name, foldName(name)]),
    ...identifiers.map((id) => [id.type, id.value, foldIdentifier(id)]),
  ];
  sql.exec(
    `INSERT OR IGNORE INTO entity_names (entity, memory, type, value, folded)
    SELECT ?1, ?2, value ->> 0, value ->> 1, value ->> 2 FROM json_each(?3)`,
    entity,
    memory,
    JSON.stringify(rows)
  );
};

/**
 * When the first memory the reader may read that mentions the entity at
 * `entity` was learned: null when there is none, so they may not see it. What
 * entities are ordered by, so where one stands among those a reader sees
 * depends only on what they may read: an entity linked long ago through
 * a hidden memory stands where its first memory they may read puts it.
 */
const firstMentionSql = (entity: string): string => `(SELECT min(first) FROM (
  SELECT m.learned_at AS first FROM memories AS m
  WHERE m.entity = ${entity} AND m.learned_at <= ?9 AND ${visibleSql("m")}
  UNION ALL
  SELECT m.learned_at FROM memories AS m
  WHERE m.object = ${entity} AND m.learned_at <= ?9 AND ${visibleSql("m")}
))`;

/**
 * `?1` the kind or null, `?4` the names and identifiers asked (JSON, each
 * `[type, folded]`, every one to be held), `?5` the most to read, `?6` 1
 * to go on after the entity whose place is `?7` (when its first memory
 * the reader may read was learned) and `?8` (its id), `?9` the moment the
 * first page was read: the entities the reader may see by a memory
 * learned by then that hold each, by a memory they may read, in that
 * order, then by id.
 */
// Its cost: by kind alone, every entity of that kind is checked for a
// memory the reader may read (and its first one found) before the limit,
// so it grows with the entities of the kind. A name or an identifier
// narrows it through `entity_names` first. No cheap bound keeps the order
// exact; measure before a client's scale.
const findSql = `
WITH ${readableSql},
found AS MATERIALIZED (
  SELECT entities.row AS row, entities.id AS id, entities.kind AS kind,
    ${firstMentionSql("entities.row")} AS first
  FROM entities
  WHERE (?1 IS NULL OR entities.kind = ?1)
    -- Found through the index of names when one is asked: the first.
    AND (json_array_length(?4) = 0 OR entities.row IN (
      SELECT entity_names.entity FROM entity_names
      WHERE entity_names.type = ?4 ->> '$[0][0]'
        AND entity_names.folded = ?4 ->> '$[0][1]'
    ))
    AND NOT EXISTS (
      SELECT 1 FROM json_each(?4) AS asked
      WHERE NOT EXISTS (
        SELECT 1 FROM entity_names
        JOIN memories AS m ON m.row = entity_names.memory
        WHERE entity_names.entity = entities.row
          AND entity_names.type = asked.value ->> 0
          AND entity_names.folded = asked.value ->> 1
          AND m.learned_at <= ?9
          AND ${visibleSql("m")}
      )
    )
)
SELECT row, id, kind, first FROM found
WHERE first IS NOT NULL
  AND (?6 = 0 OR first > ?7 OR (first = ?7 AND id > ?8))
ORDER BY first, id
LIMIT ?5`;

/**
 * `?1` the entities asked (JSON rows): each one's earliest name a memory
 * the reader may read gave (by when that memory was learned, then its
 * id), or null.
 */
const firstNameSql = `
WITH ${readableSql}
SELECT asked.value AS entity, (
  SELECT entity_names.value FROM entity_names
  JOIN memories AS m ON m.row = entity_names.memory
  WHERE entity_names.entity = asked.value AND entity_names.type = 'name'
    AND ${visibleSql("m")}
  ORDER BY m.learned_at, m.id, entity_names.folded
  LIMIT 1
) AS name
FROM json_each(?1) AS asked`;

/** Entities found, as the reader sees them: with the earliest name they may see. */
const asSeen = (
  sql: SqlStorage,
  found: readonly { row: number; id: string; kind: string }[],
  reader: Reader
): Entity[] => {
  if (found.length === 0) {
    return [];
  }
  const names = new Map(
    sql
      .exec<{ entity: number; name: string | null }>(
        firstNameSql,
        JSON.stringify(found.map(({ row }) => row)),
        reader.person,
        JSON.stringify(reader.groups)
      )
      .toArray()
      .map(({ entity, name }) => [entity, name])
  );
  return found.map(({ row, id, kind }) => ({
    id,
    kind: kindSchema.parse(kind),
    name: names.get(row) ?? null,
  }));
};

/**
 * `?1` the entity's row, `?4` the moment read at, `?5` 1 to go on after
 * the name whose place is `?6` (when the first memory that gave it was
 * learned), `?7` (that memory's id), `?8` (its type) and `?9` (folded),
 * `?10` the most to read: each name and identifier of the entity a
 * memory the reader may read, learned by then, gave, once, as the first
 * such memory wrote it, in that order.
 */
const namesPageSql = `
WITH ${readableSql},
given AS (
  SELECT entity_names.type AS type, entity_names.value AS value,
    entity_names.folded AS folded, m.learned_at AS learned, m.id AS memory,
    row_number() OVER (
      PARTITION BY entity_names.type, entity_names.folded
      ORDER BY m.learned_at, m.id
    ) AS copy
  FROM entity_names
  JOIN memories AS m ON m.row = entity_names.memory
  WHERE entity_names.entity = ?1 AND m.learned_at <= ?4 AND ${visibleSql("m")}
)
SELECT type, value, folded, learned, memory FROM given
WHERE copy = 1
  AND (?5 = 0 OR learned > ?6 OR (learned = ?6 AND (
    memory > ?7 OR (memory = ?7 AND (
      type > ?8 OR (type = ?8 AND folded > ?9)
    ))
  )))
ORDER BY learned, memory, type, folded
LIMIT ?10`;

/** What a page of an entity's names asks (contract.ts `EntityNamesRequest`, checked). */
export interface EntityNamesAsked {
  entity: EntityId;
  reader: Reader;
  at: number;
  after?: EntityNamesCursor;
  limit: number;
}

/**
 * A page of the names and identifiers of an entity the reader may see
 * (contract.ts `readEntityNames`): one more is read than asked, to tell
 * whether more follow. An entity they may not see has none they may read.
 */
export const readEntityNames = (
  sql: SqlStorage,
  { entity, reader, at, after, limit }: EntityNamesAsked
): EntityNamesPage => {
  const [found] = sql
    .exec<{ row: number }>("SELECT row FROM entities WHERE id = ?", entity)
    .toArray();
  if (found === undefined) {
    return { names: [], more: false };
  }
  const rows = sql
    .exec<{
      type: string;
      value: string;
      folded: string;
      learned: number;
      memory: string;
    }>(
      namesPageSql,
      found.row,
      reader.person,
      JSON.stringify(reader.groups),
      at,
      after === undefined ? 0 : 1,
      after?.learnedAt.getTime() ?? 0,
      after?.memory ?? "",
      after?.type ?? "",
      after?.folded ?? "",
      limit + 1
    )
    .toArray();
  const names = rows
    .slice(0, limit)
    .map(({ type, value }) => ({ type: nameTypeSchema.parse(type), value }));
  const last = rows.at(limit - 1);
  if (rows.length <= limit || last === undefined) {
    return { names, more: false };
  }
  return {
    names,
    more: true,
    next: {
      at: new Date(at),
      learnedAt: new Date(last.learned),
      memory: last.memory,
      type: nameTypeSchema.parse(last.type),
      folded: last.folded,
    },
  };
};

/** What a find of entities asks (contract.ts `EntitiesRequest`, checked). */
export interface EntitiesAsked {
  reader: Reader;
  at: number;
  kind?: EntityKind;
  identifier?: Identifier;
  name?: string;
  after?: EntitiesCursor;
  limit: number;
}

/**
 * A page of the entities the reader may see that match (contract.ts
 * `findEntities`): one more is read than asked, to tell whether more
 * follow.
 */
export const findEntities = (
  sql: SqlStorage,
  { reader, at, kind, identifier, name, after, limit }: EntitiesAsked
): EntityPage => {
  const asked = [
    ...(identifier === undefined
      ? []
      : [[identifier.type, foldIdentifier(identifier)]]),
    ...(name === undefined ? [] : [["name", foldName(name)]]),
  ];
  const found = sql
    .exec<{ row: number; id: string; kind: string; first: number }>(
      findSql,
      kind ?? null,
      reader.person,
      JSON.stringify(reader.groups),
      JSON.stringify(asked),
      limit + 1,
      after === undefined ? 0 : 1,
      after?.learnedAt.getTime() ?? 0,
      after?.entity ?? "",
      at
    )
    .toArray();
  const entities = asSeen(sql, found.slice(0, limit), reader);
  const last = found.at(limit - 1);
  if (found.length <= limit || last === undefined) {
    return { entities, more: false };
  }
  return {
    entities,
    more: true,
    next: {
      at: new Date(at),
      learnedAt: new Date(last.first),
      entity: last.id,
    },
  };
};

/** `?1` the entity's id: it, if the reader may see it. */
const oneSql = `
WITH ${readableSql}
SELECT entities.row AS row, entities.id AS id, entities.kind AS kind
FROM entities
WHERE entities.id = ?1 AND ${mentionedSql("entities.row")}`;

/** An entity, if the reader may see it (contract.ts `readEntity`). */
export const readEntity = (
  sql: SqlStorage,
  { entity, reader }: { entity: EntityId; reader: Reader }
): Entity | null => {
  const found = sql
    .exec<{ row: number; id: string; kind: string }>(
      oneSql,
      entity,
      reader.person,
      JSON.stringify(reader.groups)
    )
    .toArray();
  return asSeen(sql, found, reader).at(0) ?? null;
};
