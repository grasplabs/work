import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

/** `value NOT IN (...values)`, bound as one parameter, as `inList` is. */
export const notInList = (value: SQLWrapper, values: readonly string[]): SQL =>
  sql`${value} NOT IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;

/** Whether D1 refused a write for a unique index, however it was wrapped. */
export const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes("UNIQUE constraint failed") ||
    isUniqueViolation(error.cause));

/**
 * What D1 says when it couldn't be reached for a moment or reset under
 * the call (Cloudflare's own list of errors worth retrying), never a
 * refusal of what was asked: a constraint, a syntax error, a limit.
 */
const transientD1Error =
  /Network connection lost|storage caused object to be reset|reset because its code was updated|D1 DB is overloaded|transient issue on remote node/u;

/**
 * Whether a D1 call failed for a moment, however it was wrapped, so the
 * same call may be tried again: whether the failed try committed is
 * unknown.
 */
export const isTransientD1Error = (error: unknown): boolean =>
  error instanceof Error &&
  (transientD1Error.test(error.message) || isTransientD1Error(error.cause));

/**
 * Whether D1 refused a write because `column` (`table.column`) would be
 * NULL, however it was wrapped: the guard of an insert that selects its
 * value only where a condition holds.
 */
export const notNullFailed = (error: unknown, column: string): boolean =>
  error instanceof Error &&
  (error.message.includes(`NOT NULL constraint failed: ${column}`) ||
    notNullFailed(error.cause, column));

/**
 * `value IN (...values)`, bound as one parameter however many values there
 * are: D1 binds at most 100 to one statement.
 */
export const inList = (value: SQLWrapper, values: readonly string[]): SQL =>
  sql`${value} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;

/**
 * Splits `items` into runs of `size`: rows into inserts within D1's bound
 * parameters, statements into batches within its limits.
 */
export const chunks = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size)
  );
