import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

// The SQL helpers the Brain's queries use, over D1.

/**
 * `value IN (...values)`, bound as one parameter however many values there
 * are: D1 binds at most 100 to one statement.
 */
export const inList = (value: SQLWrapper, values: readonly string[]): SQL =>
  sql`${value} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;

/** `value NOT IN (...values)`, bound as one parameter, as `inList` is. */
export const notInList = (value: SQLWrapper, values: readonly string[]): SQL =>
  sql`${value} NOT IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;

/** The most parameters D1 binds to one statement. */
const maxBoundParameters = 100;

/**
 * `rows` in chunks of as many as one insert of them binds within D1's
 * limit, counted from the statement `bound` says one row's insert binds:
 * a row can bind more than its columns (a version taken through a guarded
 * subselect binds the guard's own), so its columns are no measure.
 */
export const insertChunks = <Row>(
  rows: readonly Row[],
  bound: (row: Row) => number
): Row[][] => {
  const [first] = rows;
  if (first === undefined) {
    return [];
  }
  const size = Math.max(1, Math.floor(maxBoundParameters / bound(first)));
  const chunks: Row[][] = [];
  for (let start = 0; start < rows.length; start += size) {
    chunks.push(rows.slice(start, start + size));
  }
  return chunks;
};

/** Whether D1 refused a write for a unique index, however it was wrapped. */
export const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes("UNIQUE constraint failed") ||
    isUniqueViolation(error.cause));
