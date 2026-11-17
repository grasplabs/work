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

/** The tokens `memory` takes of a pack's budget (`packMemoryTokens`). */
const tokensOfMemory = (memory: Memory): number =>
  packMemoryTokens({
    ...memory,
    memory: memory.id,
    context: null,
    confirmed: memory.confirmed !== null,
    found: "entities",
  });

/**
 * Newest first: by when it was learned, then by id, so the order is the
 * same at every read while the memories are.
 */
const newestFirst = (a: Memory, b: Memory): number =>
  b.learnedAt.getTime() - a.learnedAt.getTime() || b.id.localeCompare(a.id);

/**
 * The profile of `reader` (contract.ts `readProfile`): the current memories
 * about their own entity in their own word, read at one moment, newest
 * first (`newestFirst`), each whole, as many as fit `tokens` in that
 * order (`packMemoryTokens`), stopping at the first that doesn't fit.
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
  const theirs: Memory[] = [];
  if (entity === null) {
    return { memories: theirs };
  }
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
    // Their own word alone: never an outside party's, an agent's or a
    // system's, whatever is filed under them.
    theirs.push(
      ...page.memories.filter(
        ({ speaker }) =>
          speaker.kind === "internal" && speaker.person === reader.person
      )
    );
    if (!page.more || page.next === undefined) {
      break;
    }
    after = page.next;
  }
  const memories: Memory[] = [];
  let left = tokens;
  for (const memory of theirs.toSorted(newestFirst)) {
    const cost = tokensOfMemory(memory);
    if (cost > left) {
      break;
    }
    left -= cost;
    memories.push(memory);
  }
  return { memories };
};
