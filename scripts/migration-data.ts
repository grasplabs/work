/**
 * What a migration does to the rows the release before it wrote: the half
 * of migration safety the schema comparison cannot see
 * (scripts/migration-safety.ts).
 *
 * For each migration a branch adds, its database is built as main has it,
 * a few rows are written to every table, and the migration is applied to
 * them. Every row must still be there by its primary key, and every
 * column still there must hold what it held: an UPDATE or DELETE, a
 * rebuild that copies nothing or swaps columns, a table dropped and
 * created again all fail, unless the migration names the change with a
 * contract marker (`delete rows <table>`, `change values <table>.<column>`).
 * A column the migration adds may be filled from the others: it held
 * nothing before.
 *
 * Each column gets values of its own (`"chats.title#0"`, numbers counting
 * from the column's place), so a value that moved to another column is
 * told apart from one that was lost. Text is a JSON object first, so a
 * JSON rewrite changes it visibly; a migration the rows refuse is tried
 * again without the row of empty text, then on JSON strings and lists of
 * objects, so it is not refused for their shape. Rows are written parents
 * first, each child pointing at a parent's row; a CHECK's `IN (...)` gives
 * every value it allows (`= n` and `BETWEEN n` one), then one row repeats
 * another but for its key (so a dedupe shows) and one has empty text. A
 * row a constraint refuses is tried again with JSON string text and with
 * its nullable columns left empty. A table that takes no row is skipped
 * and said so, with the reason; which ones each database skips is held to
 * `skippedTables`, by name, so coverage cannot fall unnoticed. What a migration's
 * own statements delete or update is judged exactly, rows or not
 * (scripts/migration-statements.ts); these rows judge what its rebuilds
 * keep.
 *
 * D1 and Durable Objects ignore `PRAGMA foreign_keys = OFF`, so its
 * toggles are dropped and each migration runs in one transaction, as
 * there: a rebuild that drops a parent table deletes its children's rows
 * through their ON DELETE actions here too.
 */
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";

/**
 * The tables of each database no generated row gets into, by name: add
 * one only with the reason, remove one when it is covered again.
 */
export const skippedTables: Readonly<Record<string, readonly string[]>> = {
  "apps/core/src/db/core/migrations": [
    // Triggers refuse rows unless the run, App, workflow or candidate they
    // name exists in a given state.
    "accounts",
    "app_candidate_reports",
    "app_candidates",
    "dependency_admission_refusals",
    "dependency_build_leases",
    "dependency_locks",
    "dependency_requests",
    "run_lineage_attempts",
    "run_lineages",
    // Their parents are among those.
    "run_lineage_accounts",
    "run_lineage_children",
  ],
  "packages/brain-next/src/db/migrations": [
    // Full-text tables.
    "chunk_stems",
    "chunk_words",
    "memory_stems",
    "memory_words",
    // One row, which another table's trigger writes first.
    "word_index",
  ],
};

/**
 * What is wrong with which tables of `dir` took no row: they must be the
 * ones `skippedTables` names, so a change in coverage is seen in review.
 */
export const skippedErrors = (
  dir: string,
  skipped: readonly Skipped[],
  baseline: Readonly<Record<string, readonly string[]>> = skippedTables
): string[] => {
  const expected = new Set(baseline[dir]);
  const actual = new Set(skipped.map(({ table }) => table));
  const errors: string[] = [];
  const added = skipped.filter(({ table }) => !expected.has(table));
  if (added.length > 0) {
    errors.push(
      `${dir}: ${added.map(({ table, reason }) => `${table} (${reason})`).join(", ")} take no generated row, so the data check covers less: make them take one, or add them to skippedTables in scripts/migration-data.ts with the reason.`
    );
  }
  const covered = [...expected].filter((table) => !actual.has(table));
  if (covered.length > 0) {
    errors.push(
      `${dir}: ${covered.join(", ")} take generated rows now: remove them from skippedTables in scripts/migration-data.ts.`
    );
  }
  return errors;
};

/** Rows written per table. */
const ROWS = 3;

/** A change to the rows the release before wrote, as markers name it. */
export interface DataChange {
  subject: string;
  detail?: string;
}

/** Contract markers that name a change to data rather than to schema. */
export const isDataSubject = (subject: string): boolean =>
  subject.startsWith("delete rows ") || subject.startsWith("change values ");

interface Column {
  name: string;
  type: string;
  notNull: boolean;
}

interface ForeignKey {
  parent: string;
  from: string[];
  to: string[];
}

interface Table {
  name: string;
  columns: Column[];
  primaryKey: string[];
  foreignKeys: ForeignKey[];
  /** By column, lower-cased: the values a CHECK's `IN (...)` allows. */
  allowed: Map<string, string[]>;
}

/** A table that took no row, and why. */
export interface Skipped {
  table: string;
  reason: string;
}

/** A row as written. */
type Row = Record<string, SQLInputValue>;

/** A row as read back. */
type Stored = Record<string, SQLOutputValue>;

const rows = (db: DatabaseSync, sql: string, ...values: SQLInputValue[]) =>
  db.prepare(sql).all(...values);

const text = (value: unknown): string =>
  typeof value === "string" ? value : String(value);

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Every ordinary table, and every virtual one, of `db`. */
const tableNames = (db: DatabaseSync): { name: string; virtual: boolean }[] =>
  rows(db, "PRAGMA table_list")
    .filter(
      (table) =>
        table.schema === "main" &&
        (table.type === "table" || table.type === "virtual") &&
        !text(table.name).startsWith("sqlite_")
    )
    .map((table) => ({
      name: text(table.name),
      virtual: table.type === "virtual",
    }));

const tableOf = (db: DatabaseSync, name: string): Table => {
  const info = rows(db, `PRAGMA table_xinfo(${quoted(name)})`).filter(
    // Generated columns: never written.
    (column) => column.hidden === 0
  );
  const created = text(
    rows(db, "SELECT sql FROM sqlite_master WHERE name = ?", name)[0]?.sql ?? ""
  );
  const allowed = new Map<string, string[]>();
  for (const match of created.matchAll(
    /["`[]?(?<column>\w+)["`\]]?\s+in\s*\((?<values>(?:\s*'(?:[^']|'')*'\s*,?)+)\)/giu
  )) {
    allowed.set(
      (match.groups?.column ?? "").toLowerCase(),
      [
        ...(match.groups?.values ?? "").matchAll(/'(?<value>(?:[^']|'')*)'/gu),
      ].map((value) => (value.groups?.value ?? "").replaceAll("''", "'"))
    );
  }
  // `id = 1` (a table of one row) and `priority BETWEEN 0 AND 4`.
  for (const match of created.matchAll(
    /["`[]?(?<column>\w+)["`\]]?\s*(?:=|\bbetween\b)\s*(?<value>-?\d+)/giu
  )) {
    allowed.set((match.groups?.column ?? "").toLowerCase(), [
      match.groups?.value ?? "",
    ]);
  }
  const columns = info.map((column) => ({
    name: text(column.name),
    type: text(column.type).toUpperCase(),
    notNull: column.notnull === 1 || Number(column.pk) > 0,
  }));
  return {
    name,
    columns,
    primaryKey: info
      .filter((column) => Number(column.pk) > 0)
      .toSorted((a, b) => Number(a.pk) - Number(b.pk))
      .map((column) => text(column.name)),
    foreignKeys: [
      ...Map.groupBy(
        rows(db, `PRAGMA foreign_key_list(${quoted(name)})`),
        (part) => text(part.id)
      ).values(),
    ].map((parts) => ({
      parent: text(parts[0]?.table),
      from: parts.map((part) => text(part.from)),
      to: parts.map((part) => (part.to === null ? "" : text(part.to))),
    })),
    allowed,
  };
};

/** Tables with each one's parents before it; a cycle keeps its order. */
const parentsFirst = (tables: readonly Table[]): Table[] => {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const ordered: Table[] = [];
  const seen = new Set<string>();
  const visit = (table: Table, path: Set<string>): void => {
    if (seen.has(table.name) || path.has(table.name)) {
      return;
    }
    path.add(table.name);
    for (const { parent } of table.foreignKeys) {
      const parentTable = byName.get(parent);
      if (parentTable !== undefined) {
        visit(parentTable, path);
      }
    }
    seen.add(table.name);
    ordered.push(table);
  };
  for (const table of tables) {
    visit(table, new Set());
  }
  return ordered;
};

/** A value of its own for `column`, by its type's affinity (SQLite 3.1). */
/**
 * How text is written: each a JSON value, since a migration may read a
 * text column as JSON: an object first (so `json_set` and `json_remove`
 * change it visibly), a string, or a list of objects.
 */
export type TextStyle = "string" | "object" | "list";

/** How rows are written: their text's shape, and whether one is empty. */
export interface Rows {
  style?: TextStyle;
  /** A row with empty text, which is no JSON. */
  empty?: boolean;
}

const textValue = (value: string, style: TextStyle): string =>
  JSON.stringify(
    { string: value, object: { seed: value }, list: [{ seed: value }] }[style]
  );

const valueFor = (
  table: Table,
  column: Column,
  place: number,
  row: number,
  style: TextStyle
): SQLInputValue => {
  const allowed = table.allowed.get(column.name.toLowerCase());
  if (allowed !== undefined && allowed.length > 0) {
    return allowed[row % allowed.length] ?? null;
  }
  const number = (place + 1) * 1000 + row + 1;
  const { type } = column;
  if (type.includes("INT")) {
    return number;
  }
  if (/CHAR|CLOB|TEXT/u.test(type)) {
    return textValue(`${table.name}.${column.name}#${row}`, style);
  }
  if (type === "" || type.includes("BLOB")) {
    return new TextEncoder().encode(`${table.name}.${column.name}#${row}`);
  }
  if (/REAL|FLOA|DOUB/u.test(type)) {
    return number + 0.5;
  }
  return number;
};

/**
 * One row's own values: each column's for row `row`, or for a row that
 * repeats row 0 but for its primary key, or one whose text is empty.
 */
const ownRow = (
  table: Table,
  row: number,
  style: TextStyle,
  kind: "own" | "duplicate" | "empty"
): Row =>
  Object.fromEntries(
    table.columns.map((column, place) => {
      const keyed = table.primaryKey.includes(column.name);
      const value = valueFor(
        table,
        column,
        place,
        kind === "duplicate" && !keyed ? 0 : row,
        style
      );
      return [
        column.name,
        kind === "empty" &&
        !keyed &&
        typeof value === "string" &&
        !table.allowed.has(column.name.toLowerCase())
          ? ""
          : value,
      ];
    })
  );

/** The rows to try for one row of `table`, in order. */
const attempts = (
  table: Table,
  own: Row,
  { row, nullFirst }: { row: number; nullFirst: boolean },
  written: ReadonlyMap<string, Row[]>,
  tables: ReadonlyMap<string, Table>
): Row[] => {
  const nullable = table.columns.filter((column) => !column.notNull);
  const allNull = Object.fromEntries(
    nullable.map((column) => [column.name, null])
  );
  // Each parent row in turn, from the one of the same place: a parent's
  // row a trigger reads as closed (a removed App) refuses children.
  const choices = Math.max(
    1,
    ...table.foreignKeys.map(({ parent }) => written.get(parent)?.length ?? 0)
  );
  return Array.from({ length: choices }, (_, offset) => {
    const base: Row = { ...own };
    for (const key of table.foreignKeys) {
      const parentRows =
        key.parent === table.name ? [base] : (written.get(key.parent) ?? []);
      const parent =
        parentRows[(row + offset) % Math.max(parentRows.length, 1)];
      // A key that names no columns references the parent's primary key.
      const to = key.to.some((column) => column === "")
        ? (tables.get(key.parent)?.primaryKey ?? [])
        : key.to;
      for (const [at, from] of key.from.entries()) {
        const target = to[at];
        if (parent !== undefined && target !== undefined && target in parent) {
          base[from] = parent[target] ?? null;
        }
      }
    }
    const asJson: Row = Object.fromEntries(
      Object.entries(base).map(([name, value]) => [
        name,
        typeof value === "string" ? JSON.stringify({ seed: value }) : value,
      ])
    );
    const variants = [
      base,
      asJson,
      ...nullable.map((column) => ({ ...base, [column.name]: null })),
    ];
    // The last row leaves its nullable columns empty first: a parent with
    // them all set may read as closed (removed) to its children.
    return nullFirst
      ? [{ ...base, ...allNull }, ...variants]
      : [...variants, { ...base, ...allNull }];
  }).flat();
};

const firstLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

/**
 * Writes a few rows to every table of `db`: which tables took them, and
 * which took none and why.
 */
export const seed = (
  db: DatabaseSync,
  { style = "object", empty = true }: Rows = {}
): { seeded: string[]; skipped: Skipped[] } => {
  const names = tableNames(db);
  const skipped: Skipped[] = names
    .filter(({ virtual }) => virtual)
    .map(({ name }) => ({ table: name, reason: "a virtual table" }));
  const written = new Map<string, Row[]>();
  const tables = new Map(
    names
      .filter(({ virtual }) => !virtual)
      .map(({ name }) => [name, tableOf(db, name)] as const)
  );
  for (const table of parentsFirst([...tables.values()])) {
    if (table.columns.length === 0) {
      continue;
    }
    const insert = db.prepare(
      `INSERT INTO ${quoted(table.name)} (${table.columns.map(({ name }) => quoted(name)).join(", ")}) VALUES (${table.columns.map(() => "?").join(", ")})`
    );
    const done: Row[] = [];
    let refusal: string | undefined;
    const write = (
      row: number,
      kind: "own" | "duplicate" | "empty",
      nullFirst: boolean
    ): void => {
      // Text of another shape falls back to a JSON string, so a table that
      // takes only strings is not left empty for the shape.
      const tries = (shape: TextStyle) =>
        attempts(
          table,
          ownRow(table, row, shape, kind),
          { row, nullFirst },
          written,
          tables
        );
      for (const attempt of [
        ...tries(style),
        ...(style === "string" ? [] : tries("string")),
      ]) {
        try {
          insert.run(...table.columns.map(({ name }) => attempt[name] ?? null));
          done.push(attempt);
          return;
        } catch (error) {
          if (kind === "own") {
            refusal ??= firstLine(error);
          }
        }
      }
    };
    // Every value a CHECK allows, and at least three rows.
    const count = Math.max(
      ROWS,
      ...[...table.allowed.values()].map((values) => values.length)
    );
    for (let row = 0; row < count; row += 1) {
      write(row, "own", row === count - 1);
    }
    // Where the constraints allow: a row that repeats another but for its
    // key, so a dedupe is seen, and one whose text is empty.
    write(count, "duplicate", false);
    if (empty) {
      write(count + 1, "empty", false);
    }
    if (done.length === 0) {
      skipped.push({ table: table.name, reason: refusal ?? "no row" });
    } else {
      written.set(table.name, done);
    }
  }
  return { seeded: [...written.keys()], skipped };
};

/**
 * The rows of a table, the columns that find one again, and each row's
 * rowid (none in a WITHOUT ROWID table), which an UPDATE of its key keeps.
 */
interface TableRows {
  key: string[];
  rows: Stored[];
  rowids: SQLOutputValue[];
}

/** Every ordinary table's rows. */
export type Snapshot = Map<string, TableRows>;

/** A table's rows, with their rowids where it has them. */
const tableRows = (db: DatabaseSync, name: string): TableRows => {
  const key = tableOf(db, name).primaryKey;
  try {
    const read = rows(db, `SELECT rowid AS "rowid ", * FROM ${quoted(name)}`);
    return {
      key,
      rows: read.map((row) =>
        Object.fromEntries(
          Object.entries(row).filter(([column]) => column !== "rowid ")
        )
      ),
      rowids: read.map((row) => row["rowid "] ?? null),
    };
  } catch {
    // A WITHOUT ROWID table.
    return { key, rows: rows(db, `SELECT * FROM ${quoted(name)}`), rowids: [] };
  }
};

export const snapshotOf = (db: DatabaseSync): Snapshot =>
  new Map(
    tableNames(db)
      .filter(({ virtual }) => !virtual)
      .map(({ name }) => [name, tableRows(db, name)])
  );

/** Whether `a` and `b` are the same value, of the same type. */
const same = (
  a: SQLOutputValue | undefined,
  b: SQLOutputValue | undefined
): boolean =>
  a instanceof Uint8Array || b instanceof Uint8Array
    ? a instanceof Uint8Array &&
      b instanceof Uint8Array &&
      Buffer.from(a).equals(b)
    : a === b;

const shown = (value: unknown): string =>
  value instanceof Uint8Array
    ? `x'${Buffer.from(value).toString("hex")}'`
    : JSON.stringify(value);

/**
 * What `db` lost or changed of main's rows (`before`: those main wrote, as
 * the branch's earlier migrations left them), in the columns main has
 * (`main`), and those rows as they are now, for the next migration. A row,
 * a table or a column the branch added is its own to change.
 */
/**
 * What `now` lost or changed of `old`, one table's rows, and the rows of
 * `now` that are `old`'s: found by key, or by rowid when an UPDATE changed
 * the key.
 */
const rowChanges = (
  table: string,
  old: TableRows,
  now: TableRows,
  kept: readonly string[]
): { changes: DataChange[]; followed: TableRows } => {
  const found: DataChange[] = [];
  // Without a primary key, a row is found again by all it holds.
  const findBy = old.key.length > 0 ? old.key : kept;
  let lost = 0;
  const changed = new Map<string, { rows: number; detail: string }>();
  const followed: TableRows = { key: now.key, rows: [], rowids: [] };
  // Each row found again once: of two equal rows, one may be lost. By
  // key first, for every row; then by rowid, among the rows no key found,
  // for a row whose key an UPDATE changed.
  const unmatched = new Set(now.rows.keys());
  const byKey = old.rows.map((row) => {
    const index = [...unmatched].find((candidate) =>
      findBy.every((column) => same(now.rows[candidate]?.[column], row[column]))
    );
    if (index !== undefined) {
      unmatched.delete(index);
    }
    return index;
  });
  for (const [at, row] of old.rows.entries()) {
    const rowid = old.rowids[at];
    const match =
      byKey[at] ??
      [...unmatched].find(
        (index) =>
          rowid !== undefined &&
          now.rowids[index] !== undefined &&
          same(now.rowids[index], rowid)
      );
    const matched = match === undefined ? undefined : now.rows[match];
    if (match === undefined || matched === undefined) {
      lost += 1;
      continue;
    }
    unmatched.delete(match);
    followed.rows.push(matched);
    followed.rowids.push(now.rowids[match] ?? null);
    for (const column of kept) {
      if (!same(matched[column], row[column])) {
        const moved = kept.find(
          (other) => other !== column && same(matched[column], row[other])
        );
        const entry = changed.get(column) ?? {
          rows: 0,
          detail:
            moved === undefined
              ? `${shown(row[column])} to ${shown(matched[column])}`
              : `now holds what ${table}.${moved} held`,
        };
        entry.rows += 1;
        changed.set(column, entry);
      }
    }
  }
  if (lost > 0) {
    found.push({
      subject: `delete rows ${table}`,
      detail: `${lost} of ${old.rows.length} rows gone`,
    });
  }
  for (const [column, { rows: count, detail }] of changed) {
    found.push({
      subject: `change values ${table}.${column}`,
      detail: `${count} of ${old.rows.length} rows, ${detail}`,
    });
  }
  return { changes: found, followed };
};

export const dataChanges = (
  before: Snapshot,
  db: DatabaseSync,
  main: Snapshot
): { changes: DataChange[]; followed: Snapshot } => {
  const after = snapshotOf(db);
  const changes: DataChange[] = [];
  const followed: Snapshot = new Map();
  for (const [table, old] of before) {
    const now = after.get(table);
    const mainColumns = Object.keys(main.get(table)?.rows[0] ?? {});
    // A table or key column dropped is the schema check's to judge.
    if (now === undefined || old.rows.length === 0) {
      continue;
    }
    const columns =
      Object.keys(now.rows[0] ?? {}).length > 0
        ? Object.keys(now.rows[0] ?? {})
        : tableOf(db, table).columns.map(({ name }) => name);
    if (!old.key.every((column) => columns.includes(column))) {
      continue;
    }
    const kept = Object.keys(old.rows[0] ?? {}).filter(
      (column) => columns.includes(column) && mainColumns.includes(column)
    );
    const compared = rowChanges(table, old, now, kept);
    changes.push(...compared.changes);
    followed.set(table, compared.followed);
  }
  return { changes, followed };
};

/** A migration as D1 and Durable Objects run it: `foreign_keys` stays on. */
export const asDeployed = (sql: string): string =>
  sql.replaceAll(/^\s*PRAGMA\s+foreign_keys\s*=\s*\w+\s*;/gimu, "");
