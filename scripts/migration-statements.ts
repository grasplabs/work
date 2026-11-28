/**
 * What each statement of a migration a branch adds writes to, as SQLite
 * itself reports it while it prepares the statement (its authorizer), and
 * so whatever rows its WHERE would match: the exact half of the data check
 * (scripts/migration-data.ts writes rows and compares, which sees only
 * what its rows meet).
 *
 * In a migration a branch adds, a DELETE from a table main has, or an
 * UPDATE of a column main has, needs a contract marker
 * (`delete rows <table>`, `change values <table>.<column>`). Free: an
 * INSERT, an UPDATE of a column the branch adds (its backfill), any write
 * to a table the migration creates (drizzle-kit's rebuild tables), and
 * what triggers write. An INSERT that replaces the rows it conflicts with
 * (`INSERT OR REPLACE`, `REPLACE INTO`, a constraint's `ON CONFLICT
 * REPLACE`) needs `delete rows`: SQLite reports it as an INSERT, so its
 * program is read (EXPLAIN) for the delete it does. `ON CONFLICT DO
 * UPDATE` is reported as the UPDATE it is. A table rebuilt whose rows the
 * generator could not write needs `delete rows` too: what the rebuild
 * keeps of it is not seen.
 *
 * SQLite splits the migration into statements itself (each prepared
 * statement's own text), so each change is told with its statement.
 */
import { constants } from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";

/** A write a statement makes, outside triggers. */
export interface Write {
  kind: "delete" | "update" | "drop" | "replace";
  table: string;
  column?: string;
  statement: string;
}

/** A change a marker must name, and the statements that make it. */
export interface StatementChange {
  subject: string;
  detail: string;
  statements: string[];
}

/** A statement as messages show it: its SQL without comments, on a line. */
export const shownStatement = (statement: string): string => {
  const line = statement
    .split("\n")
    .filter((part) => !part.trim().startsWith("--"))
    .join(" ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
};

/**
 * Whether a prepared INSERT replaces rows it conflicts with (REPLACE, or
 * a constraint's ON CONFLICT REPLACE): its own program deletes them. A
 * trigger's program comes after it in EXPLAIN, its addresses from 0 again.
 */
const replaces = (db: DatabaseSync, statement: string): boolean => {
  const program = db.prepare(`EXPLAIN ${statement}`).all();
  const triggers = program.findIndex(({ addr }, at) => at > 0 && addr === 0);
  return program
    .slice(0, triggers === -1 ? program.length : triggers)
    .some(({ opcode }) => opcode === "Delete");
};

/**
 * Runs `sql` on `db` statement by statement, as SQLite splits it (each
 * prepared statement's own text), with what each writes.
 */
export const runRecordingWrites = (db: DatabaseSync, sql: string): Write[] => {
  const writes: Write[] = [];
  let rest = sql;
  for (;;) {
    const own: Write[] = [];
    const inserted = new Set<string>();
    db.setAuthorizer((action, first, second, _database, trigger) => {
      if (trigger === null && first !== null && !first.startsWith("sqlite_")) {
        if (action === constants.SQLITE_DROP_TABLE) {
          own.push({ kind: "drop", table: first, statement: "" });
        } else if (action === constants.SQLITE_DELETE) {
          own.push({ kind: "delete", table: first, statement: "" });
        } else if (action === constants.SQLITE_UPDATE && second !== null) {
          own.push({
            kind: "update",
            table: first,
            column: second,
            statement: "",
          });
        } else if (action === constants.SQLITE_INSERT) {
          inserted.add(first);
        }
      }
      return constants.SQLITE_OK;
    });
    let statement: string;
    try {
      statement = db.prepare(rest).sourceSQL;
    } catch (error) {
      // What is left holds no statement: only comments or space.
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ERR_INVALID_ARG_VALUE"
      ) {
        break;
      }
      throw error;
    } finally {
      db.setAuthorizer(null);
    }
    rest = rest.slice(rest.indexOf(statement) + statement.length);
    // A DROP TABLE deletes its rows too: it is judged as a drop.
    const dropped = new Set(
      own.filter(({ kind }) => kind === "drop").map(({ table }) => table)
    );
    writes.push(
      ...own
        .filter(({ kind, table }) => !(kind === "delete" && dropped.has(table)))
        .map((write) => ({ ...write, statement })),
      ...(inserted.size > 0 &&
      // An upsert's DO UPDATE is reported as the UPDATE it is, and an
      // UPDATE's program deletes and writes rows again too.
      !own.some(({ kind }) => kind === "update") &&
      replaces(db, statement)
        ? [...inserted].map((table) => ({
            kind: "replace" as const,
            table,
            statement,
          }))
        : [])
    );
    db.exec(statement);
  }
  return writes;
};

/** The tables a migration's writes are judged against, by name. */
export interface WriteContext {
  /** Each table main has, with its columns, lower-cased. */
  base: ReadonlyMap<string, { columns: ReadonlyMap<string, unknown> }>;
  /** The tables there were before this migration, and after it. */
  before: ReadonlySet<string>;
  after: ReadonlySet<string>;
  /** The tables the generator wrote no rows to. */
  skipped: ReadonlySet<string>;
}

/** What of `writes` a contract marker must name, one per subject. */
export const statementChanges = (
  writes: readonly Write[],
  { base, before, after, skipped }: WriteContext
): StatementChange[] => {
  const changes = new Map<string, StatementChange>();
  const add = (subject: string, detail: string, statement: string): void => {
    const change = changes.get(subject) ?? { subject, detail, statements: [] };
    const shown = shownStatement(statement);
    if (!change.statements.includes(shown)) {
      change.statements.push(shown);
    }
    changes.set(subject, change);
  };
  for (const { kind, table, column, statement } of writes) {
    // A table this migration creates, or the branch did, holds no rows
    // the release before wrote.
    const mains = before.has(table) ? base.get(table) : undefined;
    if (mains === undefined) {
      continue;
    }
    if (kind === "delete") {
      add(
        `delete rows ${table}`,
        "a DELETE, whatever rows it matches",
        statement
      );
    } else if (kind === "replace") {
      add(
        `delete rows ${table}`,
        "an INSERT that replaces the rows it conflicts with, whatever they are",
        statement
      );
    } else if (
      kind === "update" &&
      column !== undefined &&
      mains.columns.has(column.toLowerCase())
    ) {
      add(
        `change values ${table}.${column}`,
        "an UPDATE, whatever rows it matches",
        statement
      );
    } else if (kind === "drop" && after.has(table) && skipped.has(table)) {
      add(
        `delete rows ${table}`,
        "rebuilt, and no generated row could be written to it, so what the rebuild keeps is not checked",
        statement
      );
    }
  }
  return [...changes.values()];
};
