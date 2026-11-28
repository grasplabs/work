/**
 * What each statement of a migration a branch adds writes, as SQLite
 * itself reports it while it prepares the statement (its authorizer) and
 * as its program shows (EXPLAIN), whatever rows its WHERE would match: the
 * exact half of the data check (scripts/migration-data.ts writes rows and
 * compares, which sees only what its rows meet).
 *
 * Two flat rules, on any table the statement names, main's or one the
 * branch made, a temp table or not, so no table's history needs knowing:
 *
 * - Every DELETE and every UPDATE needs a contract marker
 *   (`delete rows <table>`, `change values <table>.<column>`), and so does
 *   an INSERT that replaces the rows it conflicts with (`INSERT OR
 *   REPLACE`, `REPLACE INTO`, a constraint's `ON CONFLICT REPLACE`), which
 *   SQLite reports as an INSERT and EXPLAIN shows deleting. Free: an
 *   UPDATE of a column the branch added to a table main has (a backfill).
 * - Every INSERT ... SELECT must be a plain copy by the opcodes of its
 *   program (PLAIN_COPY: one table read row by row, its columns and
 *   literals handed on; a view, CTE, WHERE, CASE, function, join or LIMIT
 *   shows up there, inlined) or carry `change values <table>`, naming the
 *   table it fills. Free: filling a table the migration creates that the
 *   branch never renames, from tables the branch never drops or renames
 *   (a derived table). A new column filled from an expression needs the
 *   marker too. `INSERT ... VALUES` is free.
 *
 * Writes through a trigger main has are free; a trigger the branch adds or
 * changes writes as the statement that fires it. A table rebuilt whose
 * rows the generator could not write needs `delete rows` too: what the
 * rebuild keeps of it is not seen.
 *
 * SQLite splits the migration into statements itself (each prepared
 * statement's own text), so each change is told with its statement.
 */
import { constants } from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";

/** A write a statement makes, itself or through a trigger the branch made. */
export interface Write {
  kind: "delete" | "update" | "drop" | "rename" | "replace" | "copy";
  table: string;
  column?: string;
  statement: string;
  /** For a copy: why it is more than a plain copy. */
  detail?: string;
  /** For a copy: the tables it reads, and whether it fills a new table. */
  sources?: readonly string[];
  intoNew?: boolean;
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
  // ORDER BY: rows sorted, none left out or changed.
  "SorterOpen",
  "SorterInsert",
  "SorterSort",
  "SorterData",
  "SorterNext",
  "OpenPseudo",
  "MakeRecord",
  "Move",
]);

/** The SELECT of an INSERT ... SELECT: the coroutine SQLite compiles it to. */
const selectOf = (program: readonly string[]): string[] => {
  const start = program.indexOf("InitCoroutine");
  const end = program.indexOf("EndCoroutine");
  return start === -1 || end === -1 ? [] : program.slice(start + 1, end);
};

/**
 * Whether an INSERT reads rows from a table: a SELECT that opens one (the
 * VALUES of several rows compile to a coroutine too, opening none), or the
 * direct copy SQLite makes of a bare `SELECT *` (RowData). An INSERT's own
 * foreign key lookups open tables outside the coroutine.
 */
const insertsSelected = (program: readonly string[]): boolean =>
  program.includes("RowData") || selectOf(program).includes("OpenRead");

/**
 * Why an INSERT ... SELECT is more than a plain copy, by the opcodes of
 * its program; none for a plain one. SQLite copies a bare `SELECT *` row
 * by row (RowData), which is plain.
 */
const notPlain = (program: readonly string[], functions: boolean): string[] => {
  if (program.includes("RowData")) {
    return [];
  }
  const select = selectOf(program);
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
    const altered = new Set<string>();
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
        } else if (action === constants.SQLITE_ALTER_TABLE && second !== null) {
          altered.add(second);
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
      // An INSERT ... SELECT: plain, or a change to the rows it copies.
      const sources = [...read].filter((table) => !inserted.has(table));
      if (inserted.size > 0 && insertsSelected(program)) {
        const why = notPlain(program, functions);
        if (why.length > 0) {
          writes.push(
            ...[...inserted].map((table) => ({
              kind: "copy" as const,
              table,
              statement,
              detail: why.join(", "),
              sources,
              intoNew: !atStart.has(table),
            }))
          );
        }
      }
    }
    db.exec(statement);
    // An ALTER TABLE whose table is gone after it renamed it.
    if (altered.size > 0) {
      const now = tableNames(db);
      writes.push(
        ...[...altered]
          .filter((table) => !now.has(table))
          .map((table) => ({ kind: "rename" as const, table, statement }))
      );
    }
  }
  return writes;
};

/** What a migration's writes are judged against. */
export interface WriteContext {
  /** Each table main has, with its columns, lower-cased. */
  base: ReadonlyMap<string, { columns: ReadonlyMap<string, unknown> }>;
  /** The tables the branch's migrations drop or rename, all of them. */
  moved: ReadonlySet<string>;
  /** The tables there are after this migration. */
  after: ReadonlySet<string>;
  /** The tables the generator wrote no rows to. */
  skipped: ReadonlySet<string>;
}

/** What of `writes` a contract marker must name, one per subject. */
export const statementChanges = (
  writes: readonly Write[],
  { base, moved, after, skipped }: WriteContext
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
  for (const write of writes) {
    const { kind, table, column, statement, detail } = write;
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
      // A backfill: a column the branch added, to a table main has.
      !(
        base.has(table) &&
        base.get(table)?.columns.has(column.toLowerCase()) === false
      )
    ) {
      add(
        `change values ${table}.${column}`,
        "an UPDATE, whatever rows it matches",
        statement
      );
    } else if (
      kind === "copy" &&
      !(
        write.intoNew === true &&
        !moved.has(table) &&
        (write.sources ?? []).every((source) => !moved.has(source))
      )
    ) {
      add(
        `change values ${table}`,
        `filled by a copy that is more than a plain copy, so it may leave rows out or rewrite them (a new column filled from an expression counts too): ${detail ?? ""}`,
        statement
      );
    } else if (
      kind === "drop" &&
      base.has(table) &&
      after.has(table) &&
      skipped.has(table)
    ) {
      add(
        `delete rows ${table}`,
        "rebuilt, and no generated row could be written to it, so what the rebuild keeps is not checked",
        statement
      );
    }
  }
  return [...changes.values()];
};
