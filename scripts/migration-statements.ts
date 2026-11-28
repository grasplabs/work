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
 * what main's triggers write. An INSERT that replaces the rows it conflicts with
 * (`INSERT OR REPLACE`, `REPLACE INTO`, a constraint's `ON CONFLICT
 * REPLACE`) needs `delete rows`: SQLite reports it as an INSERT, so its
 * program is read (EXPLAIN) for the delete it does. `ON CONFLICT DO
 * UPDATE` is reported as the UPDATE it is. A table rebuilt whose rows the
 * generator could not write needs `delete rows` too: what the rebuild
 * keeps of it is not seen.
 *
 * A rebuild's copy (an INSERT into a table the migration creates, from a
 * table main has that it drops) must be a plain copy, by the opcodes of
 * its prepared program (EXPLAIN, against PLAIN_COPY), or carry
 * `change values <table>`: a copy that filters, rewrites, dedupes or
 * limits passes the generated rows when no generated value meets it.
 *
 * Writes through a trigger main has are free; a trigger the branch adds or
 * changes writes as the statement that fires it.
 *
 * SQLite splits the migration into statements itself (each prepared
 * statement's own text), so each change is told with its statement.
 */
import { constants } from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";

/** A write a statement makes, itself or through a trigger the branch made. */
export interface Write {
  kind: "delete" | "update" | "drop" | "replace" | "copy";
  table: string;
  column?: string;
  statement: string;
  /** For a copy: why it is more than a plain copy. */
  detail?: string;
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
 * The opcodes of a statement's own program, and of the trigger programs
 * that come after it in EXPLAIN, each from address 0 again. An INSERT
 * that replaces the rows it conflicts with (REPLACE, a constraint's ON
 * CONFLICT REPLACE) deletes them in its program.
 */
const programOf = (
  db: DatabaseSync,
  statement: string
): { own: string[]; triggers: string[] } => {
  const program = db
    .prepare(`EXPLAIN ${statement}`)
    .all()
    .map(({ addr, opcode }) => ({ addr, opcode: String(opcode) }));
  const start = program.findIndex(({ addr }, at) => at > 0 && addr === 0);
  const end = start === -1 ? program.length : start;
  return {
    own: program.slice(0, end).map(({ opcode }) => opcode),
    triggers: program.slice(end).map(({ opcode }) => opcode),
  };
};

/**
 * What a plain copy's SELECT (the coroutine SQLite compiles for an
 * INSERT ... SELECT) does: read one table row by row and hand each row's
 * columns on, with literals for columns the old table lacks. A WHERE, a
 * CASE or a function adds comparisons, jumps and Function; a LIMIT adds
 * DecrJumpZero; DISTINCT, ORDER BY and joins add sorters, ephemeral tables
 * and a second cursor.
 */
const PLAIN_COPY = new Set([
  "OpenRead",
  "Rewind",
  "Column",
  "Rowid",
  "Yield",
  "Next",
  "Null",
  "String8",
  "Integer",
  "Real",
  // Reading a REAL column, which may hold an integer.
  "RealAffinity",
  "Blob",
  "Copy",
  "SCopy",
]);

/**
 * Why an INSERT ... SELECT is more than a plain copy, by the opcodes of
 * its program; none for a plain one. SQLite copies a bare `SELECT *` row
 * by row (RowData), which is plain.
 */
const notPlain = (program: readonly string[], functions: boolean): string[] => {
  if (program.includes("RowData")) {
    return [];
  }
  const start = program.indexOf("InitCoroutine");
  const end = program.indexOf("EndCoroutine");
  if (start === -1 || end === -1) {
    return ["no plain INSERT ... SELECT"];
  }
  const select = program.slice(start + 1, end);
  const why = [...new Set(select.filter((opcode) => !PLAIN_COPY.has(opcode)))];
  if (select.filter((opcode) => opcode === "OpenRead").length > 1) {
    why.push("OpenRead of a second table");
  }
  if (functions && !why.includes("Function") && !why.includes("PureFunc")) {
    why.push("a function call");
  }
  return why;
};

/** Each trigger's SQL, by name. */
export const triggerSql = (db: DatabaseSync): Map<string, string> =>
  new Map(
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map(({ name, sql }) => [String(name), String(sql)])
  );

const tableNames = (db: DatabaseSync): Set<string> =>
  new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map(({ name }) => String(name))
  );

/**
 * Runs `sql` on `db` statement by statement, as SQLite splits it (each
 * prepared statement's own text), with what each writes. A trigger main
 * has (`mainTriggers`, by name, as written) writes for main's release: what
 * it writes is free. What any other trigger writes is the statement's own.
 */
export const runRecordingWrites = (
  db: DatabaseSync,
  sql: string,
  mainTriggers: ReadonlyMap<string, string>
): Write[] => {
  const writes: Write[] = [];
  const atStart = tableNames(db);
  let rest = sql;
  for (;;) {
    const triggers = triggerSql(db);
    const own: Write[] = [];
    const inserted = new Set<string>();
    const insertedByTriggers = new Set<string>();
    const updated = new Set<string>();
    const read = new Set<string>();
    let functions = false;
    db.setAuthorizer((action, first, second, _database, trigger) => {
      const mains =
        trigger !== null &&
        mainTriggers.has(trigger) &&
        mainTriggers.get(trigger) === triggers.get(trigger);
      if (!mains && first !== null && !first.startsWith("sqlite_")) {
        const through = trigger === null ? "" : ` (through trigger ${trigger})`;
        if (action === constants.SQLITE_DROP_TABLE) {
          own.push({ kind: "drop", table: first, statement: through });
        } else if (action === constants.SQLITE_DELETE) {
          own.push({ kind: "delete", table: first, statement: through });
        } else if (action === constants.SQLITE_UPDATE && second !== null) {
          if (trigger === null) {
            updated.add(first);
          }
          own.push({
            kind: "update",
            table: first,
            column: second,
            statement: through,
          });
        } else if (action === constants.SQLITE_INSERT) {
          (trigger === null ? inserted : insertedByTriggers).add(first);
        } else if (action === constants.SQLITE_READ && trigger === null) {
          read.add(first);
        }
      }
      if (action === constants.SQLITE_FUNCTION && trigger === null) {
        functions = true;
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
        .map((write) => ({
          ...write,
          statement: `${statement}${write.statement}`,
        }))
    );
    if (inserted.size > 0 || insertedByTriggers.size > 0) {
      const { own: program, triggers: triggerPrograms } = programOf(
        db,
        statement
      );
      // An upsert's DO UPDATE is the UPDATE the authorizer reports, and its
      // program deletes and writes the row again: not a replace.
      const replaced = [
        ...(program.includes("Delete")
          ? [...inserted].filter((table) => !updated.has(table))
          : []),
        // What the branch's triggers insert, where their programs delete:
        // judged as replaces, which may overflag.
        ...(triggerPrograms.includes("Delete") ? [...insertedByTriggers] : []),
      ];
      writes.push(
        ...[...new Set(replaced)].map((table) => ({
          kind: "replace" as const,
          table,
          statement,
        }))
      );
      // A rebuild's copy: into a table this migration creates, from one
      // that was there. Whether the old one is dropped is judged after.
      const sources = [...read].filter((table) => atStart.has(table));
      if (
        [...inserted].some((table) => !atStart.has(table)) &&
        sources.length > 0
      ) {
        const why = notPlain(program, functions);
        if (why.length > 0) {
          writes.push(
            ...sources.map((table) => ({
              kind: "copy" as const,
              table,
              statement,
              detail: why.join(", "),
            }))
          );
        }
      }
    }
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
  // A table the migration drops, kept or rebuilt under its name.
  const droppedHere = new Set(
    writes.filter(({ kind }) => kind === "drop").map(({ table }) => table)
  );
  for (const { kind, table, column, statement, detail } of writes) {
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
    } else if (kind === "copy" && droppedHere.has(table)) {
      add(
        `change values ${table}`,
        `rebuilt with a copy that is more than a plain copy, so it may leave rows out or rewrite them: ${detail ?? ""}`,
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
