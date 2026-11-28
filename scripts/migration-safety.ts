/**
 * Refuses a migration the release before it cannot run on, unless the
 * migration names each such change and the release that removed its last
 * use.
 *
 * For up to 15 minutes after a deploy, a client's Durable Objects still
 * run the previous release's code against the new schema, and the admin
 * can roll a client back. So a schema change must leave everything the
 * previous release reads and writes working (AGENTS.md, "expand, then
 * contract"). Each migration of a D1 database and of a Durable Object's
 * SQLite is applied to an empty in-memory SQLite, after the ones before
 * it, and the schema before and after it are compared. SQLite itself
 * reads the SQL, so every form drizzle-kit or a hand-written migration
 * uses (its table rebuilds among them) is judged by what it does to the
 * schema, not by how it is written. A migration is unsafe when it:
 *
 * - drops or renames a table, a view or a column,
 * - changes a column's type, or changes or removes its default,
 * - makes a column NOT NULL, or adds a NOT NULL column without a default
 *   to a table that was there,
 * - changes a table's primary key, or removes its AUTOINCREMENT,
 * - adds or changes a foreign key, a unique key (with the columns of its
 *   WHERE) or a CHECK on columns that were there only (a column the
 *   previous release does not know it writes as NULL or its default),
 * - adds or changes a trigger that can refuse a write (`RAISE(`) on a
 *   table that was there: this codebase uses them as constraints,
 * - drops or changes an index code names with `INDEXED BY`, where SQLite
 *   fails rather than scans when the index is gone or no longer fits.
 *
 * Not judged: dropping any other index. What a migration a branch adds
 * does to the rows already written (an UPDATE or DELETE, a rebuild that
 * copies nothing or swaps columns, a table dropped and created again) is
 * judged on generated rows (scripts/migration-data.ts), with markers of
 * the same form: `delete rows <table>`, `change values <table>.<column>`.
 *
 * Such a migration is the contract step of expand, then contract, and
 * passes only with one marker per unsafe change, each a whole-line
 * comment naming the change as this check does and the release from
 * which no code relies on what it changes:
 *
 *   -- contract: drop column chats.title: release 26.11.40 removed the last use
 *
 * The check reads the release id's format, and that it is not of a month
 * after this one; the reviewer confirms the release. A release before the
 * one named cannot run on this schema.
 */
import { DatabaseSync } from "node:sqlite";

import { parsePublishedReleaseId } from "@grasp-os/shared/release-id";

import {
  asDeployed,
  dataChanges,
  isDataSubject,
  seed,
  snapshotOf,
} from "./migration-data.ts";
import type { Skipped, TextStyle } from "./migration-data.ts";

/**
 * The first migration of each database this check judges, by its index
 * in the journal. The ones before it were on main before the check was,
 * and are applied everywhere already. It never rises above what main has:
 * a cut-off never covers a migration of the branch itself.
 */
export const firstChecked: Readonly<Record<string, number>> = {
  "apps/admin/src/db/migrations": 59,
  "apps/connect/src/db/migrations": 45,
  "apps/core/src/db/audit-log/migrations": 4,
  "apps/core/src/db/core/migrations": 301,
  "apps/core/src/db/data-store/migrations": 26,
  "apps/core/src/db/onboarding/migrations": 49,
  "apps/core/src/db/workspace/migrations": 48,
  "packages/brain-next/src/db/migrations": 34,
};

interface Column {
  type: string;
  notNull: boolean;
  /** Its default as compared; undefined for none, `DEFAULT NULL` too. */
  default: string | undefined;
}

/** A constraint, by the columns it reads. */
interface Constraint {
  columns: readonly string[];
}

/** A unique key, by every column it reads: its own, and its WHERE's. */
interface UniqueKey extends Constraint {
  keyColumns: readonly string[];
  /** Its WHERE as compared, empty for a key on every row. */
  where: string;
}

interface Table {
  /** By lower-cased name: SQLite's names are case-insensitive. */
  columns: Map<string, Column>;
  primaryKey: readonly string[];
  autoincrement: boolean;
  /** By what each references, as one line. */
  foreignKeys: Map<string, Constraint>;
  /** Every unique index; the primary key is judged on its own. */
  uniqueKeys: UniqueKey[];
  /** By expression, without quotes and runs of whitespace. */
  checks: Map<string, Constraint>;
}

interface Trigger {
  table: string;
  sql: string;
}

/** A database's schema, as the check compares it. */
export interface Schema {
  tables: Map<string, Table>;
  views: Set<string>;
  /** Every index created by name, lower-cased, to its definition. */
  indexes: Map<string, string>;
  triggers: Map<string, Trigger>;
}

/**
 * One change the previous release cannot run on: what its marker names,
 * and what else the message says.
 */
export interface Change {
  subject: string;
  detail?: string;
}

const rows = (db: DatabaseSync, sql: string): Record<string, unknown>[] =>
  db.prepare(sql).all();

const text = (value: unknown): string =>
  typeof value === "string" ? value : String(value);

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** A string literal, a quoted name, a comment, or a CHECK's start. */
const TOKEN =
  /'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|\bcheck\s*\(/giu;

const isComment = (token: string): boolean =>
  token.startsWith("--") || token.startsWith("/*");

/** `sql` with each comment a space: SQLite keeps them in what it stores. */
const withoutComments = (sql: string): string =>
  sql.replaceAll(TOKEN, (token) => (isComment(token) ? " " : token));

/**
 * SQL for comparing: no quotes around names, no runs of whitespace, one
 * case, but each string literal as it is written.
 */
const normalized = (sql: string): string =>
  withoutComments(sql)
    .split(/(?<literal>'(?:[^']|'')*')/u)
    .map((part, at) =>
      at % 2 === 1
        ? part
        : part
            .replaceAll(/[`"[\]]/gu, "")
            .replaceAll(/\s+/gu, " ")
            .toLowerCase()
    )
    .join("")
    .trim();

/** The columns of `table` an expression names. */
const columnsIn = (
  expression: string,
  table: ReadonlyMap<string, Column>
): string[] => [
  ...new Set(
    (
      normalized(expression)
        .replaceAll(/'(?:[^']|'')*'/gu, "")
        .match(/[a-z_][a-z0-9_]*/gu) ?? []
    ).filter((word) => table.has(word))
  ),
];

/**
 * Where the parenthesis that opens at `open` closes, past strings and
 * names, and the offsets of the commas directly inside it.
 */
const closing = (
  sql: string,
  open: number
): { end: number; commas: number[] } => {
  const commas: number[] = [];
  let depth = 0;
  let quote: string | undefined;
  for (let at = open; at < sql.length; at += 1) {
    const char = sql.charAt(at);
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      }
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return { end: at, commas };
      }
    } else if (char === "," && depth === 1) {
      commas.push(at);
    }
  }
  return { end: sql.length, commas };
};

/** The expression of every CHECK in a CREATE TABLE. */
export const checksOf = (created: string): string[] => {
  const sql = withoutComments(created);
  const found: string[] = [];
  const tokens = new RegExp(TOKEN.source, TOKEN.flags);
  for (let match = tokens.exec(sql); match !== null; match = tokens.exec(sql)) {
    if (/^check/iu.test(match[0])) {
      const open = match.index + match[0].length - 1;
      const { end } = closing(sql, open);
      found.push(normalized(sql.slice(open + 1, end)));
      tokens.lastIndex = end;
    }
  }
  return found;
};

/** Each part of an index's key list, as written, by position. */
const keyParts = (created: string): string[] => {
  const open = created.indexOf("(");
  if (open === -1) {
    return [];
  }
  const { end, commas } = closing(created, open);
  return [open, ...commas, end]
    .slice(0, -1)
    .map((from, at) => created.slice(from + 1, [...commas, end][at] ?? end));
};

const uniqueKeyOf = (
  db: DatabaseSync,
  index: string,
  created: string,
  columns: ReadonlyMap<string, Column>
): UniqueKey => {
  const written = keyParts(created);
  const parts = rows(db, `PRAGMA index_xinfo(${quoted(index)})`).filter(
    (part) => part.key === 1
  );
  const keyColumns = parts.map((part, at) => {
    if (part.name === null) {
      // An expression has no column name: its own text tells it apart.
      return `<${normalized(written[at] ?? "").replace(/\s+(?:asc|desc)$/u, "")}>`;
    }
    const collation = text(part.coll).toLowerCase();
    const column = text(part.name).toLowerCase();
    return collation === "binary" ? column : `${column} collate ${collation}`;
  });
  const where = /\swhere\s(?<where>.*)$/isu.exec(created)?.groups?.where ?? "";
  return {
    keyColumns,
    // A UNIQUE in the CREATE TABLE has no SQL of its own: only columns.
    // From its SQL, the key's expressions and WHERE read columns too.
    columns:
      created === ""
        ? parts.map((part) => text(part.name).toLowerCase())
        : columnsIn(created.slice(created.indexOf("(")), columns),
    where: normalized(where),
  };
};

const defaultOf = (value: unknown): string | undefined =>
  value === null || text(value).toUpperCase() === "NULL"
    ? undefined
    : normalized(text(value));

const tableOf = (
  db: DatabaseSync,
  name: string,
  sql: string,
  indexSql: ReadonlyMap<string, string>
): Table => {
  const info = rows(db, `PRAGMA table_xinfo(${quoted(name)})`).filter(
    // Generated columns and a virtual table's own: never written.
    (column) => column.hidden === 0
  );
  const columns = new Map(
    info.map((column) => [
      text(column.name).toLowerCase(),
      {
        type: text(column.type).toLowerCase(),
        notNull: column.notnull === 1,
        default: defaultOf(column.dflt_value),
      },
    ])
  );
  const foreignKeys = new Map<string, Constraint>();
  const byId = Map.groupBy(
    rows(db, `PRAGMA foreign_key_list(${quoted(name)})`),
    (part) => text(part.id)
  );
  for (const parts of byId.values()) {
    const from = parts.map((part) => text(part.from).toLowerCase());
    const to = parts.map((part) => text(part.to));
    const [first] = parts;
    foreignKeys.set(
      `(${from.join(", ")}) references ${text(first?.table)} (${to.join(", ")}) on update ${text(first?.on_update)} on delete ${text(first?.on_delete)}`,
      { columns: from }
    );
  }
  return {
    columns,
    primaryKey: info
      .filter((column) => Number(column.pk) > 0)
      .toSorted((a, b) => Number(a.pk) - Number(b.pk))
      .map((column) => text(column.name).toLowerCase()),
    autoincrement: /\bautoincrement\b/iu.test(
      withoutComments(sql).replaceAll(/'(?:[^']|'')*'/gu, "")
    ),
    foreignKeys,
    uniqueKeys: rows(db, `PRAGMA index_list(${quoted(name)})`)
      .filter((index) => index.unique === 1 && index.origin !== "pk")
      .map((index) =>
        uniqueKeyOf(
          db,
          text(index.name),
          indexSql.get(text(index.name)) ?? "",
          columns
        )
      ),
    checks: new Map(
      checksOf(sql).map((check) => [
        check,
        { columns: columnsIn(check, columns) },
      ])
    ),
  };
};

/** The schema of `db`, as the check compares it. */
export const schemaOf = (db: DatabaseSync): Schema => {
  const listed = new Set(
    rows(db, "PRAGMA table_list")
      .filter(
        (table) =>
          table.schema === "main" &&
          // Not a virtual table's shadow tables: they go with it.
          (table.type === "table" || table.type === "virtual") &&
          !text(table.name).startsWith("sqlite_")
      )
      .map((table) => text(table.name))
  );
  const master = rows(
    db,
    "SELECT type, name, tbl_name, sql FROM sqlite_master"
  );
  const ofType = (type: string) =>
    master.filter((entry) => entry.type === type && entry.sql !== null);
  const indexSql = new Map(
    ofType("index").map((entry) => [text(entry.name), text(entry.sql)])
  );
  return {
    tables: new Map(
      ofType("table")
        .filter((entry) => listed.has(text(entry.name)))
        .map((entry) => [
          text(entry.name),
          tableOf(db, text(entry.name), text(entry.sql), indexSql),
        ])
    ),
    views: new Set(ofType("view").map((entry) => text(entry.name))),
    indexes: new Map(
      ofType("index").map((entry) => [
        text(entry.name).toLowerCase(),
        normalized(text(entry.sql)),
      ])
    ),
    triggers: new Map(
      ofType("trigger").map((entry) => [
        text(entry.name),
        { table: text(entry.tbl_name), sql: normalized(text(entry.sql)) },
      ])
    ),
  };
};

/** What of `old`'s columns `table` changes so its release cannot run. */
const columnChanges = (name: string, old: Table, table: Table): Change[] => {
  const found: Change[] = [];
  for (const [columnName, oldColumn] of old.columns) {
    const column = table.columns.get(columnName);
    const label = `${name}.${columnName}`;
    if (column === undefined) {
      found.push({
        subject: `drop column ${label}`,
        detail: "dropped or renamed",
      });
      continue;
    }
    if (column.type !== oldColumn.type) {
      found.push({
        subject: `change type ${label}`,
        detail: `${oldColumn.type || "none"} to ${column.type || "none"}`,
      });
    }
    if (column.notNull && !oldColumn.notNull) {
      found.push({ subject: `make not null ${label}` });
    }
    if (
      oldColumn.default !== undefined &&
      column.default !== oldColumn.default
    ) {
      found.push({
        subject: `change default ${label}`,
        detail: `${oldColumn.default} to ${column.default ?? "none"}`,
      });
    }
  }
  for (const [columnName, column] of table.columns) {
    if (
      !old.columns.has(columnName) &&
      column.notNull &&
      column.default === undefined
    ) {
      found.push({
        subject: `add not null column ${name}.${columnName}`,
        detail: "without a default",
      });
    }
  }
  if (old.primaryKey.join(",") !== table.primaryKey.join(",")) {
    found.push({
      subject: `change primary key ${name}`,
      detail: `(${old.primaryKey.join(", ")}) to (${table.primaryKey.join(", ")})`,
    });
  }
  if (old.autoincrement && !table.autoincrement) {
    found.push({ subject: `drop autoincrement ${name}` });
  }
  return found;
};

/** The constraints `table` adds that writes of `old`'s release can break. */
const constraintChanges = (
  name: string,
  old: Table,
  table: Table
): Change[] => {
  // A constraint that reads a column the previous release doesn't know
  // sees NULL or its default there, from that release's writes.
  const onOldColumns = ({ columns }: Constraint): boolean =>
    columns.every((column) => old.columns.has(column));
  const foreignKeys = [...table.foreignKeys]
    .filter(
      ([key, foreignKey]) =>
        !old.foreignKeys.has(key) && onOldColumns(foreignKey)
    )
    .map(([key, { columns }]) => ({
      subject: `add foreign key ${name}.${columns.join(",")}`,
      detail: key,
    }));
  // The same key, or one on some of its columns for every row (the
  // primary key among them), already made them unique.
  const earlier = [
    ...old.uniqueKeys,
    { keyColumns: old.primaryKey, columns: old.primaryKey, where: "" },
  ].filter(({ keyColumns }) => keyColumns.length > 0);
  const uniqueKeys = table.uniqueKeys
    .filter(
      (key) =>
        onOldColumns(key) &&
        !earlier.some(
          (oldKey) =>
            (oldKey.where === "" || oldKey.where === key.where) &&
            oldKey.keyColumns.every((column) => key.keyColumns.includes(column))
        )
    )
    .map((key) => ({
      subject: `add unique key ${name}`,
      detail: `(${key.keyColumns.join(", ")})${key.where === "" ? "" : ` where ${key.where}`}`,
    }));
  const checks = [...table.checks]
    .filter(
      ([check, constraint]) =>
        !old.checks.has(check) && onOldColumns(constraint)
    )
    .map(([check]) => ({ subject: `add check ${name}`, detail: check }));
  return [...foreignKeys, ...uniqueKeys, ...checks];
};

/**
 * What in `after` the release on `before` cannot run on. `indexedBy` is
 * every index name code gives `INDEXED BY`, lower-cased.
 */
export const unsafeChanges = (
  before: Schema,
  after: Schema,
  indexedBy: ReadonlySet<string> = new Set()
): Change[] => [
  ...[...before.tables].flatMap(([name, old]) => {
    const table = after.tables.get(name);
    return table === undefined
      ? [{ subject: `drop table ${name}`, detail: "dropped or renamed" }]
      : [
          ...columnChanges(name, old, table),
          ...constraintChanges(name, old, table),
        ];
  }),
  ...[...before.views]
    .filter((name) => !after.views.has(name))
    .map((name) => ({
      subject: `drop view ${name}`,
      detail: "dropped or renamed",
    })),
  ...[...before.indexes]
    .filter(
      ([name, definition]) =>
        indexedBy.has(name) && after.indexes.get(name) !== definition
    )
    .map(([name]) =>
      after.indexes.has(name)
        ? {
            subject: `change index ${name}`,
            detail: "code names it with INDEXED BY",
          }
        : {
            subject: `drop index ${name}`,
            detail: "code names it with INDEXED BY",
          }
    ),
  ...[...after.triggers]
    .filter(
      ([name, trigger]) =>
        before.tables.has(trigger.table) &&
        before.triggers.get(name)?.sql !== trigger.sql &&
        /\braise\s*\(/u.test(trigger.sql)
    )
    .map(([name, trigger]) => ({
      subject: `add trigger ${name}`,
      detail: `added or changed, and can refuse writes to ${trigger.table}`,
    })),
];

/** A line that means to be a contract marker, however it is spelled. */
const MARKER_LIKE = /^--\s*contract\b/iu;
const MARKER =
  /^-- contract: (?<subject>.+): release (?<release>\S+) removed the last use$/u;

/** A marker as it must read, for messages. */
export const markerFor = (subject: string): string =>
  `-- contract: ${subject}: release YY.MM.N removed the last use`;

const YEAR_2000 = 2000;

/**
 * The changes a migration's contract markers name, each with its release,
 * and what is wrong with them. A marker is a whole-line `--` comment,
 * outside strings and block comments. Its release must read as a
 * published one and not be of a month after `now`'s: whether that release
 * exists is the reviewer's to confirm.
 */
export const contractMarkers = (
  sql: string,
  now: Date
): { subjects: Set<string>; errors: string[] } => {
  const subjects = new Set<string>();
  const errors: string[] = [];
  const tokens = new RegExp(TOKEN.source, TOKEN.flags);
  for (let match = tokens.exec(sql); match !== null; match = tokens.exec(sql)) {
    const [token] = match;
    const lineStart = sql.lastIndexOf("\n", match.index - 1) + 1;
    if (
      !token.startsWith("--") ||
      sql.slice(lineStart, match.index).trim() !== "" ||
      !MARKER_LIKE.test(token)
    ) {
      continue;
    }
    const line = token.trimEnd();
    const groups = MARKER.exec(line)?.groups;
    const release = parsePublishedReleaseId(groups?.release ?? "");
    if (groups?.subject === undefined || release === undefined) {
      errors.push(
        `has the contract marker "${line}", which must read "${markerFor("<change>")}" with a release id such as 26.11.40`
      );
    } else if (
      (YEAR_2000 + release.year) * 12 + release.month >
      now.getUTCFullYear() * 12 + now.getUTCMonth() + 1
    ) {
      errors.push(
        `names release ${groups.release}, which is of a later month than this one`
      );
    } else if (subjects.has(groups.subject)) {
      errors.push(`has two contract markers for ${groups.subject}`);
    } else {
      subjects.add(groups.subject);
    }
  }
  return { subjects, errors };
};

/** One migration as its journal orders it. */
export interface Migration {
  idx: number;
  tag: string;
  sql: string;
}

/** How a database is judged. */
export interface Judging {
  /** The first migration judged, by its index in the journal. */
  from: number;
  /** For a marker's release: none may be of a later month. */
  now: Date;
  /** Every index name code gives `INDEXED BY`, lower-cased. */
  indexedBy: ReadonlySet<string>;
  /**
   * The first migration the branch adds, whose changes to the rows the
   * release before wrote are judged too (scripts/migration-data.ts).
   */
  added: number;
}

const judge = (
  file: string,
  sql: string,
  changes: readonly Change[],
  { now, dataJudged }: { now: Date; dataJudged: boolean }
): string[] => {
  const { subjects, errors } = contractMarkers(sql, now);
  const found = errors.map((error) => `${file} ${error}.`);
  const unmarked = changes.filter(({ subject }) => !subjects.has(subject));
  if (unmarked.length > 0) {
    found.push(
      [
        `${file} breaks the release before it, which still runs on the new schema for a while and after a rollback:`,
        ...unmarked.map(
          ({ subject, detail }) =>
            `  - ${subject}${detail === undefined ? "" : ` (${detail})`}`
        ),
        "  Expand first: add columns as nullable or with a default, and remove the last use in a release before. Then, as the contract step, name each change and the release that removed its last use, in the migration:",
        ...[...new Set(unmarked.map(({ subject }) => subject))].map(
          (subject) => `  ${markerFor(subject)}`
        ),
      ].join("\n")
    );
  }
  const changed = new Set(changes.map(({ subject }) => subject));
  for (const subject of subjects) {
    // A migration main has already had its data judged when it was added.
    if (!changed.has(subject) && (dataJudged || !isDataSubject(subject))) {
      found.push(
        `${file} has a contract marker for ${subject}, which it does not change in a way the release before it relies on: remove the marker.`
      );
    }
  }
  return found;
};

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const TEXT_STYLES = ["string", "object", "list"] as const;

const replayOnRows = (
  migrations: readonly Migration[],
  added: number,
  style: TextStyle
): { results: Map<number, Change[] | string>; skipped: Skipped[] } => {
  const results = new Map<number, Change[] | string>();
  const db = new DatabaseSync(":memory:");
  try {
    for (const { sql } of migrations.filter(
      (migration) => migration.idx < added
    )) {
      db.exec(asDeployed(sql));
    }
    db.exec("PRAGMA foreign_keys = ON");
    const { skipped } = seed(db, style);
    for (const { idx, sql } of migrations.filter(
      (migration) => migration.idx >= added
    )) {
      const before = snapshotOf(db);
      try {
        db.exec("BEGIN");
        db.exec(asDeployed(sql));
        db.exec("COMMIT");
      } catch (error) {
        results.set(idx, message(error));
        break;
      }
      results.set(idx, dataChanges(before, db));
    }
    return { results, skipped };
  } finally {
    db.close();
  }
};

/** Whether every migration of a replay applied to its rows. */
const appliesToRows = ({
  results,
}: {
  results: ReadonlyMap<number, Change[] | string>;
}): boolean =>
  ![...results.values()].some((result) => typeof result === "string");

/**
 * The database as main has it (`migrations` before `added`), with a few
 * rows in every table, and what the branch's migrations do to them: what
 * each changes of the rows before it, or why it does not apply to them,
 * and the tables those rows left out that JSON string text would not.
 */
const dataOfAdded = (
  migrations: readonly Migration[],
  added: number
): { results: Map<number, Change[] | string>; leftOut: Skipped[] } => {
  if (!migrations.some(({ idx }) => idx >= added)) {
    return { results: new Map(), leftOut: [] };
  }
  // Text is written as a JSON string first; a migration that reads it as
  // an object or a list gets those, so it is not refused for the rows'
  // shape alone.
  const [first, ...others] = TEXT_STYLES.map((style) =>
    replayOnRows(migrations, added, style)
  );
  if (first === undefined) {
    return { results: new Map(), leftOut: [] };
  }
  const chosen = appliesToRows(first)
    ? first
    : (others.find(appliesToRows) ?? first);
  const skippedFirst = new Set(first.skipped.map(({ table }) => table));
  return {
    results: chosen.results,
    leftOut: chosen.skipped.filter(({ table }) => !skippedFirst.has(table)),
  };
};

/**
 * The tables of `db` that take no generated row, written in a transaction
 * undone after.
 */
const skippedOf = (db: DatabaseSync): Skipped[] => {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN");
  try {
    return seed(db).skipped;
  } finally {
    db.exec("ROLLBACK");
  }
};

/**
 * What is wrong with the migrations of one database, applied in order,
 * and which of its tables the data check cannot write to.
 */
export const checkDatabase = (
  dir: string,
  migrations: readonly Migration[],
  { from, now, indexedBy, added }: Judging
): { errors: string[]; skipped: Skipped[] } => {
  const errors: string[] = [];
  const { results: data, leftOut } = dataOfAdded(migrations, added);
  if (leftOut.length > 0) {
    errors.push(
      `${dir}: the branch's migrations apply only to rows whose text is JSON of another shape, which ${leftOut.map(({ table, reason }) => `${table} (${reason})`).join(", ")} refuse: what they do to those tables is not checked.`
    );
  }
  const db = new DatabaseSync(":memory:");
  try {
    for (const { idx, tag, sql } of migrations) {
      const file = `${dir}/${tag}.sql`;
      // A cut-off never covers what the branch adds: `from` <= `added`.
      const before = idx >= from ? schemaOf(db) : undefined;
      try {
        db.exec(sql);
      } catch (error) {
        errors.push(
          `${file} does not apply after the migrations before it: ${message(error)}`
        );
        return { errors, skipped: [] };
      }
      const onRows = data.get(idx);
      if (typeof onRows === "string") {
        errors.push(
          `${file} does not apply to the rows the release before it wrote: ${onRows}`
        );
      }
      if (before !== undefined) {
        errors.push(
          ...judge(
            file,
            sql,
            [
              ...unsafeChanges(before, schemaOf(db), indexedBy),
              ...(Array.isArray(onRows) ? onRows : []),
            ],
            { now, dataJudged: idx >= added }
          )
        );
      }
    }
    return { errors, skipped: skippedOf(db) };
  } finally {
    db.close();
  }
};

/**
 * What is wrong between a database's journal and its folder: every `.sql`
 * in the folder ships with its release (a D1 database applies them in
 * name order), and a Durable Object applies what its `migrations.js`
 * lists, so each must be exactly the journal's, in order.
 */
export const journalErrors = (
  dir: string,
  tags: readonly string[],
  sqlFiles: readonly string[],
  migrationsJs?: string
): string[] => {
  const errors: string[] = [];
  const inJournal = new Set(tags);
  const inFolder = new Set(sqlFiles.map((file) => file.replace(/\.sql$/u, "")));
  for (const tag of inFolder) {
    if (!inJournal.has(tag)) {
      errors.push(
        `${dir}/${tag}.sql is not in its journal, so nothing checks it but it would ship: generate migrations with \`vp run -r db:generate\`, or remove it.`
      );
    }
  }
  for (const tag of tags) {
    if (!inFolder.has(tag)) {
      errors.push(
        `${dir}/meta/_journal.json lists ${tag}, which has no .sql file.`
      );
    }
  }
  if (migrationsJs !== undefined) {
    const imported = new Map(
      [
        ...migrationsJs.matchAll(
          /import\s+(?<name>\w+)\s+from\s+'\.\/(?<tag>[^']+)\.sql'/gu
        ),
      ].map((match) => [match.groups?.name, match.groups?.tag])
    );
    const listed = (
      /migrations\s*:\s*\{(?<names>[^}]*)\}/u.exec(migrationsJs)?.groups
        ?.names ?? ""
    )
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => imported.get(name) ?? name);
    if (listed.join("\n") !== tags.join("\n")) {
      errors.push(
        `${dir}/migrations.js does not apply the journal's migrations, in its order: generate it again with \`vp run -r db:generate\`.`
      );
    }
  }
  return errors;
};

/**
 * What is wrong with `firstChecked`: each cut-off names a database there
 * is, and covers only migrations main already had where the branch left
 * it (`countsAtBase`, by folder), never one the branch adds.
 */
export const cutOffErrors = (
  cutOffs: Readonly<Record<string, number>>,
  dirs: ReadonlySet<string>,
  countsAtBase: ReadonlyMap<string, number>
): string[] =>
  Object.entries(cutOffs).flatMap(([dir, cutOff]) => {
    if (!dirs.has(dir)) {
      return [
        `scripts/migration-safety.ts names ${dir}, which has no journal: remove it from firstChecked.`,
      ];
    }
    const count = countsAtBase.get(dir) ?? 0;
    return cutOff > count
      ? [
          `scripts/migration-safety.ts judges ${dir} from migration ${cutOff}, but main had ${count} where the branch left it: a cut-off never covers a migration the branch adds.`,
        ]
      : [];
  });
