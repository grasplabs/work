import { entityAttributes } from "./contract.ts";
import type {
  Card,
  CardAttribute,
  CardRelation,
  EntityId,
  EntityKind,
  MemoriesCursor,
  Memory,
  Reader,
} from "./contract.ts";
import { asSeen, mentionedSql } from "./entities.ts";
import { entityRowOf, readMemories } from "./memories.ts";
import { readableSql } from "./reader-sets.ts";

// An entity's card (contract.ts `Card`): a view, built when a reader asks
// for it from the memories they may read, never stored. Its memories are
// read by statements that filter by the reader before anything is
// ordered or capped (memories.ts `readMemories`); the entities it relates
// to are named only by the names memories the reader may read gave them
// (entities.ts `asSeen`). So two readers with different access see
// different cards, and a reader sees the card a store without what is
// hidden from them would show.

/**
 * `?1` the entities' rows (JSON), `?4` the moment read at: those a memory
 * the reader may read, learned by then, mentions.
 */
const seenSql = `
WITH ${readableSql}
SELECT entities.row AS row, entities.id AS id, entities.kind AS kind
FROM json_each(?1) AS asked
JOIN entities ON entities.row = asked.value
WHERE ${mentionedSql("entities.row", "?4")}
ORDER BY asked.key`;

/** The attributes of `kind`, in the order its list gives them. */
const attributeOrder = (kind: EntityKind): Map<string, number> =>
  new Map(Object.keys(entityAttributes[kind]).map((name, at) => [name, at]));

/** The entities at `rows` the reader may see as of `at`, by row. */
const seenOf = (
  sql: SqlStorage,
  reader: Reader,
  rows: readonly number[],
  at: number
): { row: number; id: string; kind: string }[] =>
  sql
    .exec<{ row: number; id: string; kind: string }>(
      seenSql,
      JSON.stringify(rows),
      reader.person,
      JSON.stringify(reader.groups),
      at
    )
    .toArray();

/**
 * A page of the card of the entity `entity` as `reader` sees it as of
 * `at` (milliseconds, the store's read moment or the cursor's: store.ts
 * `#pageMoments`, as `readMemories` is read), after `after`, from at most
 * `limit` memories; or null when they may see no such entity by what the
 * store had learned then (`learned`).
 */
export const readCard = (
  sql: SqlStorage,
  {
    entity,
    reader,
    at,
    cursorAt,
    learned,
    after,
    limit,
  }: {
    entity: EntityId;
    reader: Reader;
    at: number;
    cursorAt: number;
    learned: number;
    after?: MemoriesCursor;
    limit: number;
  }
): Card | null => {
  const found = entityRowOf(sql, entity);
  if (found === undefined) {
    return null;
  }
  // Seen and named as of what the store had learned at the first page
  // (`learned`), as its memories are read: one snapshot across pages,
  // however far ahead `at` judges when facts are true.
  const [card] = asSeen(
    sql,
    seenOf(sql, reader, [found.row], learned),
    reader,
    learned
  );
  if (card === undefined) {
    return null;
  }
  const page = readMemories(sql, {
    entity: card.id,
    reader,
    at,
    cursorAt,
    learned,
    history: false,
    ...(after === undefined ? {} : { after }),
    limit,
  });
  const order = attributeOrder(card.kind);
  const attributes = new Map<string, CardAttribute>();
  const relations: {
    memory: Memory;
    side: CardRelation["side"];
    other: EntityId;
  }[] = [];
  const notes: Memory[] = [];
  for (const memory of page.memories) {
    if (memory.object !== null) {
      const side = memory.about === card.id ? "about" : "object";
      relations.push({
        memory,
        side,
        other: side === "about" ? memory.object : memory.about,
      });
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
  // Each related entity as the reader sees it: a memory they may read,
  // the relation, mentions it, so only its names are checked.
  const others = new Map(
    asSeen(
      sql,
      sql
        .exec<{ row: number; id: string; kind: string }>(
          "SELECT row, id, kind FROM entities WHERE id IN (SELECT value FROM json_each(?))",
          JSON.stringify([...new Set(relations.map(({ other }) => other))])
        )
        .toArray(),
      reader,
      learned
    ).map((other) => [other.id, other])
  );
  return {
    entity: card,
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
    more: page.more,
    ...(page.next === undefined ? {} : { next: page.next }),
  };
};
