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
 * what triggers write. A table rebuilt whose rows the generator could not
 * write needs `delete rows` too: what the rebuild keeps of it is not seen.
 * Not seen: an `INSERT OR REPLACE` replacing rows (SQLite reports an
 * INSERT).
 */
import { constants } from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";

/** A write a statement makes, outside triggers. */
export interface Write {
  kind: "delete" | "update" | "drop";
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
 * Runs `sql` on `db` statement by statement (drizzle-kit's breakpoints,
 * which its migrator runs one by one too), with what each writes.
 */
export const runRecordingWrites = (db: DatabaseSync, sql: string): Write[] => {
  const writes: Write[] = [];
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim() === "") {
      continue;
    }
    const own: Write[] = [];
    db.setAuthorizer((action, first, second, _database, trigger) => {
      if (trigger === null && first !== null && !first.startsWith("sqlite_")) {
        const last = own.at(-1);
        if (action === constants.SQLITE_DROP_TABLE) {
          own.push({ kind: "drop", table: first, statement });
        } else if (
          action === constants.SQLITE_DELETE &&
          // SQLite reports a DROP TABLE's own delete right after it: the
          // drop is judged as a drop, not as this delete.
          !(last?.kind === "drop" && last.table === first)
        ) {
          own.push({ kind: "delete", table: first, statement });
        } else if (action === constants.SQLITE_UPDATE && second !== null) {
          own.push({ kind: "update", table: first, column: second, statement });
        }
      }
      return constants.SQLITE_OK;
    });
    try {
      db.exec(statement);
    } finally {
      db.setAuthorizer(null);
    }
    writes.push(...own);
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
