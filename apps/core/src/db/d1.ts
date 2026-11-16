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
 * Whether D1 refused a write for touching a removed App: the triggers of
 * migration 0170 (app-removal.ts) abort any write that gives a removed
 * App something new, or changes it.
 */
export const isRemovedAppRefusal = (error: unknown): boolean =>
  error instanceof Error &&
  (/for a removed App|a removed App stays/u.test(error.message) ||
    isRemovedAppRefusal(error.cause));

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

/** Most tries of a batch that D1 failed for a moment. */
const batchTries = 3;

/**
 * `batch`, tried again when D1 fails for a moment (`isTransientD1Error`),
 * up to {@link batchTries}; any other failure is thrown at once. Only for a
 * batch that is safe to run twice: a try that committed though its answer
 * was lost runs again (making a version current compares and sets, and a
 * model response's record inserts by ID).
 */
export const retriedBatch = async <Result>(
  batch: () => Promise<Result>
): Promise<Result> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // One try after the other.
      // oxlint-disable-next-line no-await-in-loop -- see above
      return await batch();
    } catch (error) {
      if (attempt >= batchTries || !isTransientD1Error(error)) {
        throw error;
      }
    }
  }
};

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
export const inList = (
  value: SQLWrapper,
  values: readonly (string | number)[]
): SQL =>
  sql`${value} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;

/**
 * Splits `items` into runs of `size`: rows into inserts within D1's bound
 * parameters, statements into batches within its limits.
 */
export const chunks = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size)
  );

/** The most parameters D1 binds to one statement. */
export const boundParametersMax = 100;

/**
 * The most queries D1 runs for one Worker invocation (Workers Paid), a
 * `batch()` counted as one: past it, every later query of that invocation
 * fails, whichever part of it makes the query.
 */
export const queriesPerInvocationMax = 1000;

/**
 * `rows` written as statements `statementOf` makes, each as many rows as
 * D1 binds (`boundParametersMax`): each statement's own parameters are
 * counted, and one over the limit is made again with fewer rows, so rows
 * of any shape fit (a row without an optional column binds less than one
 * with it), and so does what a statement binds once (a conflict clause).
 * Throws when one row alone binds more than D1 takes.
 */
export const statementsWithin = <Row, Statement>(
  rows: readonly Row[],
  statementOf: (part: Row[]) => Statement & {
    toSQL: () => { params: unknown[] };
  }
): Statement[] => {
  const statements: Statement[] = [];
  let at = 0;
  // Each chunk starts at the size the last one was taken at: rows of one
  // shape are built about once each.
  let size = rows.length;
  while (at < rows.length) {
    size = Math.min(size, rows.length - at);
    let statement = statementOf(rows.slice(at, at + size));
    let bound = statement.toSQL().params.length;
    while (bound > boundParametersMax) {
      if (size === 1) {
        throw new Error("One row binds more parameters than D1 takes");
      }
      // Fewer rows by the share over the limit: always fewer, at least one.
      size = Math.max(1, Math.floor((size * boundParametersMax) / bound));
      statement = statementOf(rows.slice(at, at + size));
      bound = statement.toSQL().params.length;
    }
    statements.push(statement);
    at += size;
  }
  return statements;
};
