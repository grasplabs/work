import { entityKinds } from "./contract.ts";
import type { Entity, Reader } from "./contract.ts";
import { visibleSql } from "./memories.ts";
import { readableSql } from "./reader-sets.ts";

// Entities as a reader sees them, for cards and proposals (cards.ts,
// linking.ts): each with the earliest name a memory the reader may read
// gave it, as entities.ts `asSeen` gives it. Read by seek: from each
// entity's names (the names' key leads with the entity) to the memory
// that gave each, by its row; so naming an entity reads its names, never
// every memory the reader may read.

/**
 * `?1` the entities asked (JSON rows), `?4` the moment read at: each
 * one's earliest name a memory the reader may read, learned by then, gave
 * (by when that memory was learned, then its id, then the name), or null.
 */
const firstNameSql = `
WITH ${readableSql}
SELECT asked.value AS entity, (
  SELECT entity_names.value FROM entity_names
  CROSS JOIN memories AS m ON m.row = entity_names.memory
  WHERE entity_names.entity = asked.value AND entity_names.type = 'name'
    AND m.learned_at <= ?4 AND ${visibleSql("m")}
  ORDER BY m.learned_at, m.id, entity_names.folded
  LIMIT 1
) AS name
FROM json_each(?1) AS asked`;

/** An entity's kind as stored: one of `entityKinds`. */
const kindOf = (kind: string): Entity["kind"] => {
  const known = entityKinds.find((one) => one === kind);
  if (known === undefined) {
    throw new Error("The Brain holds an entity of a kind it doesn't know");
  }
  return known;
};

/** `found` as the reader sees them as of `at`: with the earliest name they may see. */
export const seenAs = (
  sql: SqlStorage,
  found: readonly { row: number; id: string; kind: string }[],
  reader: Reader,
  at: number
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
        JSON.stringify(reader.groups),
        at
      )
      .toArray()
      .map(({ entity, name }) => [entity, name])
  );
  return found.map(({ row, id, kind }) => ({
    id,
    kind: kindOf(kind),
    name: names.get(row) ?? null,
  }));
};
