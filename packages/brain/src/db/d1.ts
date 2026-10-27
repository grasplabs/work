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
 * `rows` in chunks one insert each, every chunk binding no more than D1
 * takes, by what `bound` says each row's insert binds: counted from the
 * statement, since a row can bind more than its columns (a version taken
 * through a guarded subselect binds the guard's own).
 */
export const insertChunks = <Row>(
  rows: readonly Row[],
  bound: (row: Row) => number
): Row[][] => {
  const chunks: Row[][] = [];
  let chunk: Row[] = [];
  let used = 0;
  for (const row of rows) {
    const needs = bound(row);
    if (needs > maxBoundParameters) {
      throw new RangeError(
        `One row binds ${needs} parameters; D1 binds at most ${maxBoundParameters}.`
      );
    }
    if (used + needs > maxBoundParameters) {
      chunks.push(chunk);
      chunk = [];
      used = 0;
    }
    chunk.push(row);
    used += needs;
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
};

/** Whether D1 refused a write for a unique index, however it was wrapped. */
export const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes("UNIQUE constraint failed") ||
    isUniqueViolation(error.cause));
