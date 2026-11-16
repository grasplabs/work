import { memoriesReadMax, packMemoryTokens } from "./contract.ts";
import type {
  EntityId,
  MemoriesCursor,
  Memory,
  Profile,
  Reader,
} from "./contract.ts";
import { readMemories } from "./memories.ts";

// The store's own entity (contract.ts "The store's own entity"): the
// entity a person's own store's person is, one row at most, made fresh by
// the first add that names it and never found by a name or an identifier.

/** The id of the store's own entity, if it has one. */
export const ownEntityId = (sql: SqlStorage): EntityId | null =>
  sql
    .exec<{ id: string }>(
      `SELECT entities.id AS id FROM own_entity
      JOIN entities ON entities.row = own_entity.entity
      WHERE own_entity.id = 1`
    )
    .toArray()
    .at(0)?.id ?? null;

/** Whether the entity at `row` is the store's own entity. */
export const isOwnEntityRow = (sql: SqlStorage, row: number): boolean =>
  sql
    .exec("SELECT 1 FROM own_entity WHERE id = 1 AND entity = ?", row)
    .toArray().length > 0;

/**
 * The row of the store's own entity: the one it has, or else a new
 * `person` made now. Run inside an add's transaction, so two first adds
 * make one.
 */
export const ownEntityRow = (sql: SqlStorage): number => {
  const [linked] = sql
    .exec<{ entity: number }>("SELECT entity FROM own_entity WHERE id = 1")
    .toArray();
  if (linked !== undefined) {
    return linked.entity;
  }
  const { row } = sql
    .exec<{ row: number }>(
      "INSERT INTO entities (id, kind) VALUES (?, 'person') RETURNING row",
      crypto.randomUUID()
    )
    .one();
  sql.exec("INSERT INTO own_entity (id, entity) VALUES (1, ?)", row);
  return row;
};

/**
 * The profile of `reader` (contract.ts `readProfile`): the current memories
 * about their own entity in their own word, as `readMemories` orders
 * them, read at one moment, each whole, as many as fit `tokens` in that
 * order (`packMemoryTokens`); cut short at the first that doesn't fit.
 * Nothing while the store has no own entity. One synchronous read: a
 * snapshot.
 */
export const readProfile = (
  sql: SqlStorage,
  {
    reader,
    tokens,
    ...moments
  }: {
    reader: Reader & { person: string };
    tokens: number;
    at: number;
    cursorAt: number;
    learned: number;
  }
): Profile => {
  const entity = ownEntityId(sql);
  const memories: Memory[] = [];
  if (entity === null) {
    return { memories, truncated: false };
  }
  let left = tokens;
  let after: MemoriesCursor | undefined;
  for (;;) {
    const page = readMemories(sql, {
      entity,
      reader,
      ...moments,
      history: false,
      ...(after === undefined ? {} : { after }),
      limit: memoriesReadMax,
    });
    for (const memory of page.memories) {
      // Their own word alone: never an outside party's, an agent's or a
      // system's, whatever is filed under them.
      if (
        memory.speaker.kind === "internal" &&
        memory.speaker.person === reader.person
      ) {
        const cost = packMemoryTokens({
          ...memory,
          memory: memory.id,
          context: null,
          confirmed: memory.confirmed !== null,
          found: "entities",
        });
        if (cost > left) {
          return { memories, truncated: true };
        }
        left -= cost;
        memories.push(memory);
      }
    }
    if (!page.more || page.next === undefined) {
      break;
    }
    after = page.next;
  }
  return { memories, truncated: false };
};
