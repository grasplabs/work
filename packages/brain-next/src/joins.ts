import type { Reader } from "./contract.ts";
import { readableSql } from "./reader-sets.ts";

// Joins (contract.ts "Cards, proposals and the member link"): two
// entities a person joined by accepting a proposal, for that person's
// readers alone (`entity_joins`). Every statement that groups by entity
// for a reader resolves each entity through the joins whose set of
// readers is among the reader's (`readable`, in the same statement), so a
// reader outside a join's set reads exactly what a store without it
// gives: two entities. A join groups only what the reader may read
// already; it shows nothing more.

/**
 * The entity `entity` (an expression) stands as for the reader of the
 * statement's `readable`: the one it was joined into for them, or itself.
 */
export const joinedSql = (entity: string): string =>
  `coalesce((SELECT into_entity FROM entity_joins
    WHERE merged = ${entity} AND reader_set IN (SELECT reader_set FROM readable)), ${entity})`;

/**
 * The entity `standing` (an expression, one no join of the reader's
 * points away from) and every entity joined into it for the reader, as
 * rows (`IN (...)`).
 */
export const joinedFamilySql = (standing: string): string =>
  `SELECT ${standing} UNION ALL SELECT merged FROM entity_joins
    WHERE into_entity = ${standing} AND reader_set IN (SELECT reader_set FROM readable)`;

/** Where each of `rows` stands for `reader` (above), by row. */
export const standingOf = (
  sql: SqlStorage,
  reader: Reader,
  rows: readonly number[]
): Map<number, number> =>
  new Map(
    sql
      .exec<{ row: number; standing: number }>(
        `WITH ${readableSql}
        SELECT value AS row, ${joinedSql("value")} AS standing
        FROM json_each(?1)`,
        JSON.stringify(rows),
        reader.person,
        JSON.stringify(reader.groups)
      )
      .toArray()
      .map(({ row, standing }) => [row, standing])
  );

/** The entity standing at `row` for `reader`, and those joined into it for them. */
export const familyOf = (
  sql: SqlStorage,
  reader: Reader,
  row: number
): number[] =>
  sql
    .exec<{ row: number }>(
      `WITH ${readableSql}
      SELECT ?1 AS row
      UNION ALL SELECT merged FROM entity_joins
      WHERE into_entity = ?1 AND reader_set IN (SELECT reader_set FROM readable)`,
      row,
      reader.person,
      JSON.stringify(reader.groups)
    )
    .toArray()
    .map((found) => found.row);
