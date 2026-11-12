import { z } from "zod";

import { entityKinds } from "./contract.ts";
import type {
  Entity,
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
export const mentionedSql = (entity: string): string => `(
  EXISTS (SELECT 1 FROM memories AS m
    WHERE m.entity = ${entity} AND ${visibleSql("m")})
  OR EXISTS (SELECT 1 FROM memories AS m
    WHERE m.object = ${entity} AND ${visibleSql("m")})
)`;

/**
 * Whether the memory `alias` is read by exactly the set of readers `?3`:
 * its own set is it, and, resting on a version, so are the version's and
 * its source's current version's, the version not hidden by an erasure.
 * So everyone who may read an add with those readers may read it too.
 */
export const coveredSql = (alias: string): string => `(
  ${alias}.reader_set = ?3
  AND (${alias}.version_row IS NULL OR EXISTS (
    SELECT 1 FROM source_versions AS based
    JOIN current_versions ON current_versions.source = based.source
    JOIN source_versions AS current ON current.row = current_versions.version_row
    WHERE based.row = ${alias}.version_row
      AND based.row NOT IN (SELECT version_row FROM erasing_versions)
      AND based.reader_set = ?3 AND current.reader_set = ?3
  ))
)`;

/**
 * The first entity of `kind` holding one of `identifiers` by a memory
 * read by exactly the set of readers `readerSet` (`coveredSql`): what an add with those readers links to. An
 * identifier only a memory others read gave links nothing, so no add
 * learns that two identifiers are one entity through a memory its readers
 * may not read: it makes a new entity, and joining the two is a person's
 * or the linker's to propose (GRA-1740).
 */
export const linkedBy = (
  sql: SqlStorage,
  kind: EntityKind,
  identifiers: readonly Identifier[],
  readerSet: number
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
      readerSet
    )
    .toArray();
  return found?.row ?? undefined;
};

/**
 * Whether an add may name the entity at `entity` by its id: `reader` may see it, or, with no reader, a memory
 * read by exactly the add's set of readers `readerSet` mentions it.
 */
export const mayName = (
  sql: SqlStorage,
  entity: number,
  readerSet: number,
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
        readerSet
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
 * The first memory the reader may read that mentions the entity at
 * `entity`, by row: null when there is none, so they may not see it. What
 * entities are ordered by, so where one stands among those a reader sees
 * depends only on what they may read: an entity linked long ago through
 * a hidden memory stands where its first memory they may read puts it.
 */
const firstMentionSql = (entity: string): string => `(SELECT min(first) FROM (
  SELECT m.row AS first FROM memories AS m
  WHERE m.entity = ${entity} AND ${visibleSql("m")}
  UNION ALL
  SELECT m.row FROM memories AS m
  WHERE m.object = ${entity} AND ${visibleSql("m")}
))`;

/**
 * `?1` the kind or null, `?4` the names and identifiers asked (JSON, each
 * `[type, folded]`, every one to be held), `?5` the limit: the entities
 * the reader may see that hold each, by a memory they may read, in the
 * order of the first memory they may read that mentions each.
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
          AND ${visibleSql("m")}
      )
    )
)
SELECT row, id, kind FROM found
WHERE first IS NOT NULL
ORDER BY first
LIMIT ?5`;

/**
 * `?1` the entities asked (JSON rows): each name and identifier of them a
 * memory the reader may read gave, the earliest memory first.
 */
const namesSql = `
WITH ${readableSql}
SELECT asked.value AS entity, entity_names.type AS type,
  entity_names.value AS value, entity_names.folded AS folded
FROM json_each(?1) AS asked
JOIN entity_names ON entity_names.entity = asked.value
JOIN memories AS m ON m.row = entity_names.memory
WHERE ${visibleSql("m")}
ORDER BY asked.value, m.row, entity_names.rowid`;

/** Entities found, as the reader sees them: with the names they may see. */
export const asSeen = (
  sql: SqlStorage,
  found: readonly { row: number; id: string; kind: string }[],
  reader: Reader
): Entity[] => {
  const seen = new Map<number, { entity: Entity; keys: Set<string> }>();
  for (const { row, id, kind } of found) {
    seen.set(row, {
      entity: { id, kind: kindSchema.parse(kind), names: [], identifiers: [] },
      keys: new Set(),
    });
  }
  if (seen.size === 0) {
    return [];
  }
  const names = sql
    .exec<{ entity: number; type: string; value: string; folded: string }>(
      namesSql,
      JSON.stringify([...seen.keys()]),
      reader.person,
      JSON.stringify(reader.groups)
    )
    .toArray();
  for (const { entity, type, value, folded } of names) {
    const into = seen.get(entity);
    const key = JSON.stringify([type, folded]);
    if (into === undefined || into.keys.has(key)) {
      continue;
    }
    into.keys.add(key);
    if (type === "name") {
      into.entity.names.push(value);
    } else if (type === "email" || type === "ref") {
      into.entity.identifiers.push({ type, value });
    }
  }
  return [...seen.values()].map(({ entity }) => entity);
};

/** What a find of entities asks (contract.ts `EntitiesRequest`, checked). */
export interface EntitiesAsked {
  reader: Reader;
  kind?: EntityKind;
  identifier?: Identifier;
  name?: string;
  limit: number;
}

/** The entities the reader may see that match (contract.ts `findEntities`). */
export const findEntities = (
  sql: SqlStorage,
  { reader, kind, identifier, name, limit }: EntitiesAsked
): Entity[] => {
  const asked = [
    ...(identifier === undefined
      ? []
      : [[identifier.type, foldIdentifier(identifier)]]),
    ...(name === undefined ? [] : [["name", foldName(name)]]),
  ];
  const found = sql
    .exec<{ row: number; id: string; kind: string }>(
      findSql,
      kind ?? null,
      reader.person,
      JSON.stringify(reader.groups),
      JSON.stringify(asked),
      limit
    )
    .toArray();
  return asSeen(sql, found, reader);
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
