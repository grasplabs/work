import type { EntityId } from "./contract.ts";

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
