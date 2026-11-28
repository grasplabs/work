/**
 * Refuses a migration the release before it cannot run on, unless the
 * migration says which release stopped using what it removes.
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
 * - drops or renames a table or a column,
 * - changes a column's type,
 * - makes a column NOT NULL, drops the default of a NOT NULL column, or
 *   adds a NOT NULL column without a default to a table that was there,
 * - adds or changes a foreign key, a unique key (with the columns of its
 *   WHERE) or a CHECK on columns that were there only. A column the
 *   previous release does not know it writes as NULL or its default.
 *
 * Not judged: dropping an index the previous release's queries need, and
 * triggers, which are hand-written for their case and read in review.
 *
 * Such a migration is the contract step of expand, then contract, and
 * passes only with the marker
 *
 *   -- contract: release 26.11.40 removed the last use
 *
 * naming the published release from which no code uses what it removes
 * or writes what it now refuses. Reviewers see it in the diff; a release
 * before the one it names cannot run on this schema.
 */
import { DatabaseSync } from "node:sqlite";

import { parsePublishedReleaseId } from "@grasp-os/shared/release-id";

/**
 * The first migration of each database this check judges, by its index
 * in the journal. The ones before it were on main before the check was,
 * and are applied everywhere already.
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
  hasDefault: boolean;
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
  /** By what each references, as one line. */
  foreignKeys: Map<string, Constraint>;
  /** The primary key and every unique index. */
  uniqueKeys: UniqueKey[];
  /** By expression, without quotes and runs of whitespace. */
  checks: Map<string, Constraint>;
}

/** Each table of a database, by name. */
export type Schema = Map<string, Table>;

const rows = (db: DatabaseSync, sql: string): Record<string, unknown>[] =>
  db.prepare(sql).all();

const text = (value: unknown): string =>
  typeof value === "string" ? value : String(value);

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** A string literal, a quoted name, a comment, or a CHECK's start. */
const TOKEN =
  /'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|\bcheck\s*\(/giu;

/** `sql` with each comment a space: SQLite keeps them in what it stores. */
const withoutComments = (sql: string): string =>
  sql.replaceAll(TOKEN, (token) =>
    token.startsWith("--") || token.startsWith("/*") ? " " : token
  );

/**
 * SQL for comparing: no quotes around names, no runs of whitespace, one
 * case, but each string literal as it is written.
 */
const normalized = (sql: string): string =>
  sql
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

/** Where the parenthesis that opens at `open` closes, past strings and names. */
const closing = (sql: string, open: number): number => {
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
        return at;
      }
    }
  }
  return sql.length;
};

/** The expression of every CHECK in a CREATE TABLE. */
export const checksOf = (created: string): string[] => {
  const sql = withoutComments(created);
  const found: string[] = [];
  const tokens = new RegExp(TOKEN.source, TOKEN.flags);
  for (let match = tokens.exec(sql); match !== null; match = tokens.exec(sql)) {
    if (/^check/iu.test(match[0])) {
      const open = match.index + match[0].length - 1;
      const end = closing(sql, open);
      found.push(normalized(sql.slice(open + 1, end)));
      tokens.lastIndex = end;
    }
  }
  return found;
};

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
        // `DEFAULT NULL` is no default for a NOT NULL column.
        hasDefault:
          column.dflt_value !== null &&
          text(column.dflt_value).toUpperCase() !== "NULL",
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
  const primaryKey = info
    .filter((column) => Number(column.pk) > 0)
    .toSorted((a, b) => Number(a.pk) - Number(b.pk))
    .map((column) => text(column.name).toLowerCase());
  const uniqueKeys: UniqueKey[] = rows(db, `PRAGMA index_list(${quoted(name)})`)
    .filter((index) => index.unique === 1)
    .map((index) => {
      // A UNIQUE in the CREATE TABLE has no SQL of its own: only columns.
      const created = indexSql.get(text(index.name)) ?? "";
      const open = created.indexOf("(");
      const keyList = normalized(
        created.slice(open + 1, closing(created, open))
      );
      const parts = rows(
        db,
        `PRAGMA index_xinfo(${quoted(text(index.name))})`
      ).filter((part) => part.key === 1);
      const keyColumns = parts.map((part) => {
        // An expression has no column name: its key list tells it apart.
        const column =
          part.name === null ? `<${keyList}>` : text(part.name).toLowerCase();
        const collation = text(part.coll).toLowerCase();
        return collation === "binary"
          ? column
          : `${column} collate ${collation}`;
      });
      const where =
        /\swhere\s(?<where>.*)$/isu.exec(created)?.groups?.where ?? "";
      return {
        keyColumns,
        // From its SQL, the key's expressions and WHERE read columns too.
        columns:
          created === ""
            ? parts.map((part) => text(part.name).toLowerCase())
            : columnsIn(created.slice(open), columns),
        where: normalized(where),
      };
    });
  if (primaryKey.length > 0) {
    uniqueKeys.push({ keyColumns: primaryKey, columns: primaryKey, where: "" });
  }
  return {
    columns,
    foreignKeys,
    uniqueKeys,
    checks: new Map(
      checksOf(sql).map((check) => [
        check,
        { columns: columnsIn(check, columns) },
      ])
    ),
  };
};

/** The tables of `db`, as the check compares them. */
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
  const master = rows(db, "SELECT type, name, sql FROM sqlite_master");
  const indexSql = new Map(
    master
      .filter((entry) => entry.type === "index" && entry.sql !== null)
      .map((entry) => [text(entry.name), withoutComments(text(entry.sql))])
  );
  return new Map(
    master
      .filter((entry) => entry.type === "table" && listed.has(text(entry.name)))
      .map((entry) => [
        text(entry.name),
        tableOf(db, text(entry.name), text(entry.sql), indexSql),
      ])
  );
};

/** What of `old`'s columns `table` changes so its release cannot run. */
const columnChanges = (name: string, old: Table, table: Table): string[] => {
  const found: string[] = [];
  for (const [columnName, oldColumn] of old.columns) {
    const column = table.columns.get(columnName);
    const label = `${name}.${columnName}`;
    if (column === undefined) {
      found.push(`drops or renames column ${label}`);
      continue;
    }
    if (column.type !== oldColumn.type) {
      found.push(
        `changes the type of ${label} from ${oldColumn.type || "none"} to ${column.type || "none"}`
      );
    }
    if (column.notNull && !oldColumn.notNull) {
      found.push(`makes ${label} NOT NULL`);
    } else if (column.notNull && oldColumn.hasDefault && !column.hasDefault) {
      found.push(`drops the default of NOT NULL column ${label}`);
    }
  }
  for (const [columnName, column] of table.columns) {
    if (!old.columns.has(columnName) && column.notNull && !column.hasDefault) {
      found.push(
        `adds NOT NULL column ${name}.${columnName} without a default`
      );
    }
  }
  return found;
};

/** The constraints `table` adds that writes of `old`'s release can break. */
const constraintChanges = (
  name: string,
  old: Table,
  table: Table
): string[] => {
  // A constraint that reads a column the previous release doesn't know
  // sees NULL or its default there, from that release's writes.
  const onOldColumns = ({ columns }: Constraint): boolean =>
    columns.every((column) => old.columns.has(column));
  const foreignKeys = [...table.foreignKeys]
    .filter(
      ([key, foreignKey]) =>
        !old.foreignKeys.has(key) && onOldColumns(foreignKey)
    )
    .map(([key]) => `adds or changes a foreign key on ${name}: ${key}`);
  const uniqueKeys = table.uniqueKeys
    .filter(
      (key) =>
        onOldColumns(key) &&
        // The same key, or one on some of its columns for every row,
        // already made them unique.
        !old.uniqueKeys.some(
          (oldKey) =>
            (oldKey.where === "" || oldKey.where === key.where) &&
            oldKey.keyColumns.every((column) => key.keyColumns.includes(column))
        )
    )
    .map(
      (key) =>
        `adds a unique key on ${name} (${key.keyColumns.join(", ")})${key.where === "" ? "" : ` where ${key.where}`}`
    );
  const checks = [...table.checks]
    .filter(
      ([check, constraint]) =>
        !old.checks.has(check) && onOldColumns(constraint)
    )
    .map(([check]) => `adds or changes a CHECK on ${name}: ${check}`);
  return [...foreignKeys, ...uniqueKeys, ...checks];
};

/** What in `after` the release on `before` cannot run on, one line each. */
export const unsafeChanges = (before: Schema, after: Schema): string[] =>
  [...before].flatMap(([name, old]) => {
    const table = after.get(name);
    return table === undefined
      ? [`drops or renames table ${name}`]
      : [
          ...columnChanges(name, old, table),
          ...constraintChanges(name, old, table),
        ];
  });

/** A line that means to be a contract marker, however it is spelled. */
const MARKER = /^--\s*contract\b.*$/gimu;
const MARKER_TEXT =
  /^-- contract: release (?<release>\S+) removed the last use$/u;

/** A marker as it must read, for messages. */
export const markerExample =
  "-- contract: release 26.11.40 removed the last use";

/**
 * The release a migration's contract marker names; undefined without one,
 * an error unless it has one marker that reads as it must.
 */
export const contractMarker = (
  sql: string
): { release: string } | { error: string } | undefined => {
  const markers = (sql.match(MARKER) ?? []).map((line) => line.trimEnd());
  if (markers.length === 0) {
    return undefined;
  }
  const [line = ""] = markers;
  const release =
    markers.length === 1 ? MARKER_TEXT.exec(line)?.groups?.release : undefined;
  if (release === undefined || parsePublishedReleaseId(release) === undefined) {
    return {
      error: `needs one contract marker that reads "${markerExample}", with a published release's id, and has: ${markers.join(" | ")}`,
    };
  }
  return { release };
};

/** One migration as its journal orders it. */
export interface Migration {
  idx: number;
  tag: string;
  sql: string;
}

/**
 * What is wrong with the migrations of one database, applied in order:
 * those from `from` on are judged.
 */
export const checkDatabase = (
  dir: string,
  migrations: readonly Migration[],
  from: number
): string[] => {
  const errors: string[] = [];
  const db = new DatabaseSync(":memory:");
  try {
    for (const { idx, tag, sql } of migrations) {
      const before = idx >= from ? schemaOf(db) : undefined;
      db.exec(sql);
      if (before === undefined) {
        continue;
      }
      const file = `${dir}/${tag}.sql`;
      const changes = unsafeChanges(before, schemaOf(db));
      const marker = contractMarker(sql);
      if (marker !== undefined && "error" in marker) {
        errors.push(`${file} ${marker.error}.`);
      } else if (changes.length > 0 && marker === undefined) {
        errors.push(
          [
            `${file} breaks the release before it, which still runs on the new schema for a while and after a rollback:`,
            ...changes.map((change) => `  - ${change}`),
            "  Expand first: add columns as nullable or with a default, and remove the last use in a release before. Then, as the contract step, say which release removed it, in the migration:",
            `  ${markerExample}`,
          ].join("\n")
        );
      } else if (changes.length === 0 && marker !== undefined) {
        errors.push(
          `${file} has a contract marker but changes nothing the release before it relies on: remove the marker.`
        );
      }
    }
  } finally {
    db.close();
  }
  return errors;
};
