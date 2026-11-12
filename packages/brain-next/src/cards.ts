import { cardMemoriesMax, entityAttributes } from "./contract.ts";
import type {
  Card,
  CardAttribute,
  CardRelation,
  Entity,
  EntityId,
  EntityKind,
  Memory,
  Reader,
} from "./contract.ts";
import { asSeen, mentionedSql } from "./entities.ts";
import { familyOf, standingOf } from "./joins.ts";
import { entityRowOf, readMemories } from "./memories.ts";
import { readableSql } from "./reader-sets.ts";
import { isWritersOwn } from "./writers-own.ts";

// An entity's card (contract.ts `Card`): a view, built when a reader asks
// for it from the memories they may read, never stored. Its memories are
// read by statements that filter by the reader before anything is
// ordered or capped (memories.ts `readMemories`); the entities it relates
// to are named only by the names memories the reader may read gave them
// (entities.ts `asSeen`). So two readers with different access see
// different cards, and a reader sees the card a store without what is
// hidden from them would show.
//
// Entities the reader joined (joins.ts) are one card for them: the one
// they were joined into, with the names and memories of each, and a
// relation between two of them is no relation of the card's. For anyone
// else, each is a card of its own.

/** `?1` the entities' rows (JSON): those a memory the reader may read mentions. */
const seenSql = `
WITH ${readableSql}
SELECT entities.row AS row, entities.id AS id, entities.kind AS kind
FROM json_each(?1) AS asked
JOIN entities ON entities.row = asked.value
WHERE ${mentionedSql("entities.row")}
ORDER BY asked.key`;

/** The attributes of `kind`, in the order its list gives them. */
const attributeOrder = (kind: EntityKind): Map<string, number> =>
  new Map(Object.keys(entityAttributes[kind]).map((name, at) => [name, at]));

/** The entities at `rows` the reader may see, by row. */
const seenOf = (
  sql: SqlStorage,
  reader: Reader,
  rows: readonly number[]
): { row: number; id: string; kind: string }[] =>
  sql
    .exec<{ row: number; id: string; kind: string }>(
      seenSql,
      JSON.stringify(rows),
      reader.person,
      JSON.stringify(reader.groups)
    )
    .toArray();

/**
 * The entity standing at `row` for the reader, as they see it: its id and
 * kind, with the names and identifiers of it and of each entity they
 * joined into it, each once; or none when they may see none of them.
 */
const standingEntity = (
  sql: SqlStorage,
  reader: Reader,
  row: number
): { entity: Entity; family: number[] } | undefined => {
  const family = familyOf(sql, reader, row);
  const seen = seenOf(sql, reader, family);
  const [standing] = sql
    .exec<{ id: string; kind: string }>(
      "SELECT id, kind FROM entities WHERE row = ?",
      row
    )
    .toArray();
  if (seen.length === 0 || standing === undefined) {
    return undefined;
  }
  const [first] = asSeen(
    sql,
    [{ row, id: standing.id, kind: standing.kind }],
    reader
  );
  if (first === undefined) {
    return undefined;
  }
  const keys = new Set([
    ...first.names.map((name) => `name ${name}`),
    ...first.identifiers.map(({ type, value }) => `${type} ${value}`),
  ]);
  for (const other of asSeen(
    sql,
    seen.filter((one) => one.row !== row),
    reader
  )) {
    for (const name of other.names) {
      if (!keys.has(`name ${name}`)) {
        keys.add(`name ${name}`);
        first.names.push(name);
      }
    }
    for (const identifier of other.identifiers) {
      const key = `${identifier.type} ${identifier.value}`;
      if (!keys.has(key)) {
        keys.add(key);
        first.identifiers.push(identifier);
      }
    }
  }
  return { entity: first, family };
};

/** Memories in a card's order: by attribute (none last), confirmed first, newest first. */
const byCardOrder = (a: Memory, b: Memory): number =>
  Number(a.attribute === null) - Number(b.attribute === null) ||
  (a.attribute ?? "").localeCompare(b.attribute ?? "") ||
  Number(a.confirmed === null) - Number(b.confirmed === null) ||
  b.learnedAt.getTime() - a.learnedAt.getTime();

/**
 * The card of the entity `entity` as `reader` sees it as of `at`
 * (milliseconds), or null when they may see no such entity.
 */
export const readCard = (
  sql: SqlStorage,
  { entity, reader, at }: { entity: EntityId; reader: Reader; at: number }
): Card | null => {
  const found = entityRowOf(sql, entity);
  if (found === undefined) {
    return null;
  }
  const standing =
    standingOf(sql, reader, [found.row]).get(found.row) ?? found.row;
  const card = standingEntity(sql, reader, standing);
  if (card === undefined) {
    return null;
  }
  const ids = new Map(
    sql
      .exec<{ row: number; id: string }>(
        "SELECT row, id FROM entities WHERE row IN (SELECT value FROM json_each(?))",
        JSON.stringify(card.family)
      )
      .toArray()
      .map(({ row, id }) => [id, row])
  );
  const read = new Map<string, Memory>();
  for (const id of ids.keys()) {
    for (const memory of readMemories(sql, {
      entity: id,
      reader,
      at,
      history: false,
      limit: cardMemoriesMax + 1,
    })) {
      // An instruction is its writer's own (writers-own.ts).
      if (isWritersOwn(memory, reader)) {
        read.set(memory.id, memory);
      }
    }
  }
  const memories = [...read.values()].toSorted(byCardOrder);
  const kept = memories.slice(0, cardMemoriesMax);
  const order = attributeOrder(card.entity.kind);
  const attributes = new Map<string, CardAttribute>();
  const relations: {
    memory: Memory;
    side: CardRelation["side"];
    other: string;
  }[] = [];
  const notes: Memory[] = [];
  for (const memory of kept) {
    if (memory.object !== null) {
      const side = ids.has(memory.about) ? "about" : "object";
      const other = side === "about" ? memory.object : memory.about;
      // A relation between two entities the reader joined is no relation.
      if (!ids.has(other)) {
        relations.push({ memory, side, other });
      }
    } else if (memory.attribute === null) {
      notes.push(memory);
    } else {
      const held = attributes.get(memory.attribute) ?? {
        attribute: memory.attribute,
        memories: [],
        contested: false,
      };
      held.memories.push(memory);
      held.contested ||= memory.contested;
      attributes.set(memory.attribute, held);
    }
  }
  // Each related entity as the reader sees it, as it stands for them.
  const otherRows = new Map(
    sql
      .exec<{ row: number; id: string }>(
        "SELECT row, id FROM entities WHERE id IN (SELECT value FROM json_each(?))",
        JSON.stringify([...new Set(relations.map(({ other }) => other))])
      )
      .toArray()
      .map(({ row, id }) => [id, row])
  );
  const standings = standingOf(sql, reader, [...otherRows.values()]);
  const others = new Map<string, Entity>();
  for (const [id, row] of otherRows) {
    const seen = standingEntity(sql, reader, standings.get(row) ?? row);
    if (seen !== undefined) {
      others.set(id, seen.entity);
    }
  }
  return {
    entity: card.entity,
    attributes: [...attributes.values()].toSorted(
      (a, b) =>
        (order.get(a.attribute) ?? order.size) -
        (order.get(b.attribute) ?? order.size)
    ),
    relations: relations.flatMap(({ memory, side, other }) => {
      const seenOther = others.get(other);
      return seenOther === undefined
        ? []
        : [{ attribute: memory.attribute, side, other: seenOther, memory }];
    }),
    notes,
    truncated: memories.length > cardMemoriesMax,
  };
};
