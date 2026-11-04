import type { ValueDescriptor } from "@grasp-os/sdk";
import { schemaFromDescriptor, schemaHash } from "@grasp-os/sdk/host";
import type { ManifestTable } from "@grasp-os/sdk/host";
import {
  appDataErrors,
  appDataExportMaxRecords,
  appDataImportLimits,
  appDataImportSchema,
  appDataPageSize,
} from "@grasp-os/shared/app-data";
import type {
  AppDataApi,
  AppDataField,
  AppDataImport,
  AppDataImportError,
  AppDataImportPreview,
  AppDataImportResult,
  AppDataPage,
  AppDataRecord,
  AppDataTable,
  AppDataTables,
  RecordChangePage,
} from "@grasp-os/shared/app-data";
import type { App } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import { jsonOf } from "@grasp-os/shared/operations";
import { mintRecordId } from "@grasp-os/shared/record-ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { queryMaxResults } from "@grasp-os/shared/store-limits";
import type { ReadScope } from "@grasp-os/shared/store-queries";
import type { QueryRequest, ReadRequest } from "@grasp-os/shared/store-reads";
import { dataErrors, storedFieldsSchema } from "@grasp-os/shared/stores";
import type { StoreFields } from "@grasp-os/shared/stores";
import { CsvError, parse } from "csv-parse/sync";
import { drizzle } from "drizzle-orm/d1";

import { requireNotArchived } from "./app-access.ts";
import { loadRelease } from "./app-releases.ts";
import { appFor } from "./apps.ts";
import { keepAuditEvent } from "./audit-outbox.ts";
import { teamsOf } from "./auth/identity.ts";
import { openStore } from "./data-stores.ts";
import type { OpenStore } from "./data-stores.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { keepSensitiveReads } from "./sensitive-reads.ts";
import type { SensitiveReadContext } from "./sensitive-reads.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { requireNotStaff } from "./sharing.ts";
import type { QueryAnswer } from "./store-queries.ts";
import { StoreReader } from "./store-reader.ts";

// An App's data, from its page (`apps.data`): its builders and the
// organization's admins browse its tables, read each record's change
// history (store-changes.ts), export a table as CSV and import CSV rows
// into one. Threat model, and how each is closed:
//
// - Someone who doesn't build the App reads or changes its data: every
//   call reads the person's role in the App again and needs `builder`
//   (`appFor`), which admins have in every App; Grasp staff never (their
//   sessions don't reach the workspace, and `requireNotStaff` here). An
//   export checks again before every page it reads.
// - The browser reaching past what the table's access lets the person
//   read: every read goes through the store's own read path, scoped to
//   the person with a member's and builder's roles and the teams they are
//   in now, under the schema of the App's current version, so `none`
//   refuses, `owner` shows only the person's own records, and row rules
//   (store-rules.ts) only the rows they admit the person to, and history
//   only of those.
// - An import writing what App code couldn't: every row is checked
//   against the table's schema in core first, then lands through the
//   store's own checks for a commit's insert (the table's write access
//   for those roles, its write rules, IDs not in use, references to
//   records that exist),
//   as new records owned by the importer, recorded in the history as an
//   import by them. An archived App takes none.
// - A half-landed import: rows are checked first, all of them, and any
//   error lands nothing; then the store takes them in batches within one
//   commit's bounds and lands all of them in one transaction, or none.
// - A file too big to hold: bounded by `appDataImportLimits` before it is
//   parsed (its bytes, by the request's schema) and as it is read (rows,
//   columns, errors reported). An export stops past
//   `appDataExportMaxRecords`, never truncating silently.
// - A transfer outliving a team the person left: their teams are read
//   again with their session and role before every page an export reads
//   and before an import lands, the page read and the rows landed under
//   those, and a team lost or joined since the transfer began stops it
//   (`app_data.access_changed`) rather than go on under rows chosen by
//   the teams it began with.
// - An export or import mixing two versions: an export reads every page
//   of the version it began on and stops (`app_data.version_changed`)
//   once another is made current; an import checked against one version
//   lands only while it is still current, under that version's schema.
// - A value that doesn't come back as it went out: no value, null and
//   empty text each have a cell of their own (`fieldCell`, `cellValue`).
// - A CSV cell run as a formula where the export is opened: a text cell
//   that a spreadsheet would read as a formula (or that starts with the
//   guard itself) is written with a leading `'`, which an import takes
//   off again, so text round-trips.
// - Bulk reads and writes nobody can trace: each export and import is in
//   the audit log (`app.data.exported`, `app.data.imported`), with the
//   table and how many rows; each record an import inserts is in the
//   store's history. A table its schema declares sensitive is recorded on
//   every read besides (`app.data.read`, sensitive-reads.ts): each page
//   and record the browser reads of it, and an export's pages, once as
//   the export ends.

/** An App's current version's store, as `by` reads it here. */
interface Opened {
  readonly app: App;
  readonly version: number;
  readonly store: OpenStore;
  readonly scope: ReadScope;
  readonly tables: Readonly<Record<string, ManifestTable>>;
}

/**
 * The App `input` names, for `by`, who must build it, and its current
 * version's store: undefined when it has no current version, or no store.
 */
const opened = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<{ app: App; store?: Opened }> => {
  requireNotStaff(by);
  const app = await appFor(env, by, input, "builder");
  const version = app.currentVersion;
  if (version === null) {
    return { app };
  }
  const release = await loadRelease(env, app.id, version);
  if (release.store === null) {
    return { app };
  }
  // The teams they are in now, from core's records: what a table's `team`
  // row rules match (store-rules.ts), for the browser, an export and an
  // import alike.
  const teams = await teamsOf(env.DB, by.userId);
  return {
    app,
    store: {
      app,
      version,
      store: await openStore(env, release.store.storeId),
      scope: {
        schemaHash: await schemaHash(release.app.schema),
        principal: by.userId,
        appMember: true,
        appBuilder: true,
        teams: teams.map(({ id }) => id),
        consumer: { resourceId: app.id, resourceVersion: version },
      },
      tables: release.app.schema.tables,
    },
  };
};

/** `opened`'s store, refused as having no such table when there is none. */
const openedStore = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<Opened> => {
  const { store } = await opened(env, by, input);
  if (store === undefined) {
    throw appDataErrors.create("app_data.no_table");
  }
  return store;
};

/**
 * `openedStore`, if version `version` (what the person's page read,
 * `tables`) is still the App's current one: otherwise
 * `app_data.version_changed`, never a read or write under another
 * version's tables than the page shows.
 */
const versionedStore = async (
  env: Env,
  by: Identity,
  input: unknown,
  version: unknown
): Promise<Opened> => {
  const open = await openedStore(env, by, input);
  if (open.version !== version) {
    throw appDataErrors.create("app_data.version_changed");
  }
  return open;
};

/** Table `name` of the current version, or `app_data.no_table`. */
const tableOf = (open: Opened, name: unknown): ManifestTable => {
  const table =
    typeof name === "string" && Object.hasOwn(open.tables, name)
      ? open.tables[name]
      : undefined;
  if (table === undefined) {
    throw appDataErrors.create("app_data.no_table");
  }
  return table;
};

/** The teams `open` was read under, in one order, for comparing. */
const teamsKey = (open: Opened): string =>
  JSON.stringify((open.scope.teams ?? []).toSorted());

/**
 * Refuses (`app_data.access_changed`) to go on with work on `table` that
 * `open` began once `now`, read again just before the next step, holds
 * other teams and the table has a `team` read rule: the rows it lets them
 * reach changed, so nothing begun under the old ones reads or writes on
 * under them. Teams no rule of the table reads change nothing of it.
 */
const requireSameTeams = (open: Opened, now: Opened, table: string): void => {
  const { rules } = tableOf(open, table);
  const readsTeams = (rules?.read ?? []).some(({ kind }) => kind === "team");
  if (readsTeams && teamsKey(now) !== teamsKey(open)) {
    throw appDataErrors.create("app_data.access_changed");
  }
};

const fieldOf = ([name, descriptor]: [
  string,
  ValueDescriptor,
]): AppDataField => ({
  name,
  kind: descriptor.kind,
  required: descriptor.presence === "required",
});

/** A table as the browser lists it, sensitive as the store holds it. */
const tableView =
  (sensitive: ReadonlySet<string>) =>
  ([name, table]: [string, ManifestTable]): AppDataTable => ({
    name,
    read: table.access.read,
    write: table.access.write,
    sensitive: sensitive.has(name),
    fields: Object.entries(table.fields).map(fieldOf),
  });

/** A read document's managed fields, and its own. */
const recordOf = (document: unknown): AppDataRecord => {
  if (typeof document !== "object" || document === null) {
    throw new Error("A store's read answered something other than a record");
  }
  const {
    _id: id,
    _ownerId: owner,
    _rev: revision,
    _createdAt: createdAt,
    _updatedAt: updatedAt,
    ...fields
  }: Record<string, unknown> = { ...document };
  return {
    id: String(id),
    owner: String(owner),
    revision: Number(revision),
    createdAt: new Date(Number(createdAt)).toISOString(),
    updatedAt: new Date(Number(updatedAt)).toISOString(),
    fields,
  };
};

/** A page of `table`, newest first, of `size` records from `cursor`. */
const pageQuery = (
  table: string,
  size: number,
  cursor: string | null
): QueryRequest => ({
  descriptorVersion: 1,
  table,
  index: null,
  range: [],
  filter: null,
  order: "desc",
  terminal: { kind: "paginate", pageSize: size, cursor },
});

/** Who `by`'s reads of `open` are recorded as (sensitive-reads.ts). */
const readContext = (by: Identity, open: Opened): SensitiveReadContext => ({
  actor: actorOf(by),
  target: { type: "app", id: open.app.id },
  version: open.version,
  principal: by.userId,
  runId: null,
});

/**
 * Keeps `by`'s reads of `open`, as the browser or an export made them, of
 * each sensitive table they reached: `reads` of it, answering `rows` of
 * its records. Nothing for a table that isn't sensitive.
 */
const keepPageReads = async (
  env: Env,
  by: Identity,
  open: Opened,
  via: "browser" | "export",
  reached: ReadonlyMap<string, { reads: number; rows: number }>
): Promise<void> => {
  if (reached.size === 0) {
    return;
  }
  await keepSensitiveReads(
    env,
    readContext(by, open),
    [...reached].map(([table, { reads, rows }]) => ({
      via,
      table,
      reads,
      rows,
    }))
  );
};

/** What reads reached of sensitive tables, by table, for `keepPageReads`. */
type Reached = Map<string, { reads: number; rows: number }>;

/**
 * One read of `open`'s store for the page, through a `StoreReader` as App
 * code's reads go: what it answered of sensitive tables counted into
 * `reached`, a read that failed after it looked at records included.
 */
const readCounted = async (
  open: Opened,
  request: ReadRequest,
  reached: Reached
): Promise<QueryAnswer> =>
  await new StoreReader(open.store, open.scope).read(request, (sensitive) => {
    for (const [table, rows] of Object.entries(sensitive)) {
      const sofar = reached.get(table);
      reached.set(table, {
        reads: (sofar?.reads ?? 0) + 1,
        rows: (sofar?.rows ?? 0) + rows,
      });
    }
  });

/**
 * One page of `table` as `open` reads it, what it answered of sensitive
 * tables counted into `reached`.
 */
const readPage = async (
  open: Opened,
  table: string,
  size: number,
  cursor: string | null,
  reached: Reached
): Promise<AppDataPage> => {
  const value = await readCounted(
    open,
    { kind: "query", query: pageQuery(table, size, cursor) },
    reached
  );
  const page =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? value
      : undefined;
  const items: unknown = page?.items;
  if (page === undefined || !Array.isArray(items)) {
    throw new Error("A store's page answered something other than a page");
  }
  const next: unknown = page.nextCursor;
  return {
    records: items.map(recordOf),
    cursor: typeof next === "string" ? next : null,
  };
};

// CSV, as RFC 4180 has it: written here (quoting is all there is to it),
// read with a conformant parser (csv-parse).

/** The kinds whose values are text in a CSV cell, never JSON. */
const textKinds: ReadonlySet<string> = new Set(["string", "enum", "id"]);

/** A text cell a spreadsheet would read as a formula, or the guard itself. */
const guarded = /^[=+\-@\t\r']/u;

/** A cell that must be quoted: it holds a quote, a comma or a line break. */
const quotedCell = /[",\r\n]/u;

/** The unquoted cell that holds null, in a field of any kind. */
const nullCell = "null";

/**
 * Text as one CSV field: quoted when it must be (a quote, a comma, a line
 * break), and when it is empty or reads `null`, so it is never taken for
 * no value or for null.
 */
const quotedText = (text: string): string =>
  text === "" || text === nullCell || quotedCell.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;

/**
 * A field's value as one CSV field, which an import reads back as it was
 * (`cellValue`). In a field of any kind, no value is an empty unquoted
 * cell and null the unquoted cell `null`. A text field's text is written
 * as it is, guarded against formulas (`guarded`), quoted when empty or
 * when it reads `null`, so a quoted cell is always text; any other value
 * is JSON.
 */
const fieldCell = (
  descriptor: ValueDescriptor | undefined,
  value: unknown
): string => {
  if (value === undefined) {
    return "";
  }
  if (value === null) {
    return nullCell;
  }
  if (
    descriptor !== undefined &&
    textKinds.has(descriptor.kind) &&
    typeof value === "string"
  ) {
    return quotedText(guarded.test(value) ? `'${value}` : value);
  }
  return quotedText(JSON.stringify(value));
};

const csvLine = (cells: readonly string[]): string => `${cells.join(",")}\r\n`;

/** The column an export names a record's ID by; an import leaves it out. */
const idColumn = "_id";

/** A cell as the parser read it: its text, and whether it was quoted. */
interface Cell {
  readonly text: string;
  readonly quoted: boolean;
}

/** A cell as `readCsv`'s parser casts it. */
const cellOf = (cell: unknown): Cell => {
  const text: unknown =
    typeof cell === "object" && cell !== null
      ? Reflect.get(cell, "text")
      : undefined;
  const quoted: unknown =
    typeof cell === "object" && cell !== null
      ? Reflect.get(cell, "quoted")
      : undefined;
  if (typeof text !== "string" || typeof quoted !== "boolean") {
    throw new TypeError("The CSV parser cast a cell to something else");
  }
  return { text, quoted };
};

/** A CSV's header and rows, or what is wrong with it as a whole. */
type ReadCsv =
  | { readonly columns: string[]; readonly rows: Cell[][] }
  | { readonly error: string };

const encoder = new TextEncoder();

const tooManyColumns = `A file has at most ${appDataImportLimits.maxColumns} columns.`;

/** What the parser's cast throws to stop at a row past `maxColumns`. */
const tooManyColumnsStop = new RangeError(tooManyColumns);

/**
 * Reads `csv` (RFC 4180, CRLF or LF, a BOM allowed), bounded by its bytes,
 * its rows and its columns before anything past them is kept.
 */
const readCsv = (csv: string): ReadCsv => {
  if (encoder.encode(csv).byteLength > appDataImportLimits.maxBytes) {
    return {
      error: `An import holds at most ${appDataImportLimits.maxBytes} bytes. Split the file.`,
    };
  }
  let parsed: unknown[][];
  try {
    parsed = parse(csv, {
      bom: true,
      record_delimiter: ["\r\n", "\n"],
      relax_column_count: true,
      skip_empty_lines: true,
      // Rows past the bound aren't read: one more tells it is over.
      to: appDataImportLimits.maxRows + 1 + 1,
      // Past the bound, a row's cells aren't kept: the parse stops.
      cast: (text, context): Cell => {
        if (context.index >= appDataImportLimits.maxColumns) {
          throw tooManyColumnsStop;
        }
        return { text, quoted: context.quoting };
      },
    });
  } catch (error) {
    if (error === tooManyColumnsStop) {
      return { error: tooManyColumns };
    }
    if (error instanceof CsvError) {
      return { error: `The file isn't CSV: ${error.message}` };
    }
    throw error;
  }
  const records = parsed.map((row) => row.map(cellOf));
  const [header, ...rows] = records;
  if (header === undefined || header.length === 0) {
    return { error: "The file has no header row." };
  }
  const columns = header.map(({ text }) => text.trim());
  if (columns.length > appDataImportLimits.maxColumns) {
    return { error: tooManyColumns };
  }
  if (new Set(columns).size !== columns.length) {
    return { error: "Two columns have the same name." };
  }
  if (rows.length > appDataImportLimits.maxRows) {
    return {
      error: `An import holds at most ${appDataImportLimits.maxRows} rows. Split the file.`,
    };
  }
  return { columns, rows };
};

/** A cell as a value of a field `descriptor` describes; absent when empty. */
const cellValue = (
  descriptor: ValueDescriptor,
  cell: Cell
): { value?: unknown } | { error: string } => {
  if (!cell.quoted && cell.text === "") {
    return {};
  }
  if (!cell.quoted && cell.text === nullCell) {
    return { value: null };
  }
  if (textKinds.has(descriptor.kind)) {
    // The export's formula guard comes off again.
    return {
      value:
        cell.text.startsWith("'") && guarded.test(cell.text.slice(1))
          ? cell.text.slice(1)
          : cell.text,
    };
  }
  try {
    const value: unknown = JSON.parse(cell.text);
    return { value };
  } catch {
    return { error: `Isn't a valid ${descriptor.kind} value.` };
  }
};

/** The field each column fills, as an import first suggests it. */
const suggestedMapping = (
  columns: readonly string[],
  table: ManifestTable
): Record<string, string | null> => {
  const fields = Object.keys(table.fields);
  return Object.fromEntries(
    columns.map((column) => [
      column,
      fields.find((field) => field === column) ??
        fields.find((field) => field.toLowerCase() === column.toLowerCase()) ??
        null,
    ])
  );
};

/** Issues of a value schema, as `path: message` per field. */
interface Issue {
  readonly path?: readonly unknown[];
  readonly message: string;
}

const issueField = (issue: Issue): string | null => {
  const [first] = issue.path ?? [];
  if (typeof first === "string") {
    return first;
  }
  if (typeof first === "object" && first !== null && "key" in first) {
    return String(first.key);
  }
  return null;
};

/** What an import read: each row's fields, or its errors. */
interface CheckedRows {
  readonly rows: StoreFields[];
  readonly errors: AppDataImportError[];
}

/** A CSV's header and rows, as `readCsv` read them. */
interface ReadRows {
  readonly columns: string[];
  readonly rows: Cell[][];
}

/**
 * The field each column of `read` fills, by the column's place, as
 * `mapping` names them; or what is wrong with the mapping.
 */
const mappedColumns = (
  table: ManifestTable,
  read: ReadRows,
  mapping: AppDataImport["mapping"]
): { mapped: Map<number, string>; errors: AppDataImportError[] } => {
  const errors: AppDataImportError[] = [];
  const mapped = new Map<number, string>();
  const refuse = (column: string, field: string | null, message: string) => {
    errors.push({ row: 0, column, field, message });
  };
  for (const [column, field] of Object.entries(mapping)) {
    const at = read.columns.indexOf(column);
    if (at === -1) {
      refuse(column, field, "The file has no such column.");
    } else if (field === null) {
      // Left out.
    } else if (!Object.hasOwn(table.fields, field)) {
      refuse(column, field, "The table has no such field.");
    } else if ([...mapped.values()].includes(field)) {
      refuse(column, field, "Two columns fill this field.");
    } else {
      mapped.set(at, field);
    }
  }
  return { mapped, errors };
};

/** One row's fields as its cells say them, or what is wrong with its cells. */
const rowFields = (
  table: ManifestTable,
  read: ReadRows,
  mapped: ReadonlyMap<number, string>,
  cells: readonly Cell[],
  row: number
): { fields: Record<string, unknown> } | { errors: AppDataImportError[] } => {
  if (cells.length !== read.columns.length) {
    return {
      errors: [
        {
          row,
          column: null,
          field: null,
          message: `Has ${cells.length} cells; the header has ${read.columns.length}.`,
        },
      ],
    };
  }
  const fields: Record<string, unknown> = {};
  const errors: AppDataImportError[] = [];
  for (const [at, field] of mapped) {
    const descriptor = Object.hasOwn(table.fields, field)
      ? table.fields[field]
      : undefined;
    const cell = cells[at];
    const value =
      descriptor === undefined || cell === undefined
        ? {}
        : cellValue(descriptor, cell);
    if ("error" in value) {
      errors.push({
        row,
        column: read.columns[at] ?? null,
        field,
        message: value.error,
      });
    } else if ("value" in value) {
      // Defined, not assigned: no field name reaches the prototype.
      Object.defineProperty(fields, field, {
        enumerable: true,
        value: value.value,
      });
    }
  }
  return errors.length > 0 ? { errors } : { fields };
};

/** Checks every row of `read` against `table`, columns mapped by `mapping`. */
const checkedRows = (
  table: ManifestTable,
  read: ReadRows,
  mapping: AppDataImport["mapping"]
): CheckedRows => {
  const { mapped, errors } = mappedColumns(table, read, mapping);
  if (errors.length > 0) {
    return { rows: [], errors };
  }
  const columnOf = (field: string | null): string | null =>
    field === null
      ? null
      : (read.columns.find((_column, at) => mapped.get(at) === field) ?? null);
  const whole = schemaFromDescriptor(
    JSON.stringify({
      descriptorVersion: 1,
      kind: "object",
      presence: "required",
      nullable: false,
      fields: table.fields,
    })
  );
  const rows: StoreFields[] = [];
  for (const [index, cells] of read.rows.entries()) {
    const row = index + 1;
    const cellsRead = rowFields(table, read, mapped, cells, row);
    if ("errors" in cellsRead) {
      errors.push(...cellsRead.errors);
      continue;
    }
    const result = whole["~standard"].validate(cellsRead.fields);
    if (result instanceof Promise) {
      throw new TypeError("A record's schema validated asynchronously");
    }
    if (result.issues !== undefined) {
      for (const issue of result.issues) {
        const field = issueField(issue);
        errors.push({
          row,
          column: columnOf(field),
          field,
          message: issue.message,
        });
      }
      continue;
    }
    rows.push(storedFieldsSchema.parse(jsonOf(result.value)));
  }
  return { rows, errors };
};

/** At most `maxErrors` of `errors`, and whether there were more. */
const reported = (
  errors: readonly AppDataImportError[]
): AppDataImportResult => ({
  ok: false,
  errors: errors.slice(0, appDataImportLimits.maxErrors),
  more: errors.length > appDataImportLimits.maxErrors,
});

/**
 * What an import into `table` of `open`'s store does, for `by`, who is
 * read again (`recheck`: their session, role and teams) just before it
 * lands.
 */
const importRows = async (
  env: Env,
  by: Identity,
  input: unknown,
  table: string,
  request: unknown,
  recheck: () => Promise<Opened>
): Promise<AppDataImportResult> => {
  const { version, csv, mapping } = appDataErrors.parse(
    "app_data.invalid",
    appDataImportSchema,
    request
  );
  const open = await versionedStore(env, by, input, version);
  requireNotArchived(open.app);
  const declared = tableOf(open, table);
  const read = readCsv(csv);
  if ("error" in read) {
    return reported([
      { row: 0, column: null, field: null, message: read.error },
    ]);
  }
  if (read.rows.length === 0) {
    return reported([
      { row: 0, column: null, field: null, message: "The file has no rows." },
    ]);
  }
  const { rows, errors } = checkedRows(declared, read, mapping);
  if (errors.length > 0) {
    return reported(errors);
  }
  const importId = crypto.randomUUID();
  const now = Date.now();
  const ids = rows.map(() => mintRecordId(now));
  for (
    let from = 0;
    from < rows.length;
    from += appDataImportLimits.batchRows
  ) {
    // One batch after the other, each within a commit's bounds.
    // oxlint-disable-next-line no-await-in-loop -- see above
    await open.store.stageImport({
      importId,
      principal: by.userId,
      table,
      from,
      rows: rows
        .slice(from, from + appDataImportLimits.batchRows)
        .map((fields, offset) => ({ id: ids[from + offset] ?? "", fields })),
    });
  }
  // Their session, role and teams read again just before it lands: a
  // role or a team lost while the batches went lands nothing, and the
  // rows land under the teams they are in now, never those it began with.
  const still = await recheck();
  requireNotArchived(still.app);
  if (still.version !== open.version) {
    throw appDataErrors.create("app_data.version_changed");
  }
  requireSameTeams(open, still, table);
  try {
    // Its audit event lands with its rows, in the store's transaction:
    // in the log exactly when they are in the store, and once, as a
    // staged import lands once.
    const { inserted } = await open.store.applyImport({
      importId,
      principal: by.userId,
      actor: actorOf(by),
      roles: {
        appMember: true,
        appBuilder: true,
        teams: [...(still.scope.teams ?? [])],
      },
      schemaHash: still.scope.schemaHash,
      rows: rows.length,
      audit: { app: open.app.id, version: open.version, table },
    });
    return { ok: true, inserted };
  } catch (error) {
    // The store refused the rows as a commit's inserts would be refused:
    // the row it names, or the import as a whole.
    if (dataErrors.codeOf(error) === undefined || !isExpectedError(error)) {
      throw error;
    }
    const details: unknown = Reflect.get(error, "details");
    const id: unknown =
      typeof details === "object" && details !== null
        ? Reflect.get(details, "id")
        : undefined;
    const at = typeof id === "string" ? ids.indexOf(id) : -1;
    return reported([
      { row: at + 1, column: null, field: null, message: error.message },
    ]);
  }
};

/**
 * `table` as CSV, a page at a time as the client takes it in, checking
 * with `recheck` before every page; recorded before anything is read, and
 * what it read of a sensitive table handed to `keep` as it ends.
 */
const exportStream = (
  open: Opened,
  table: string,
  recheck: () => Promise<Opened>,
  keep: (reached: Reached) => Promise<void>
): ReadableStream<Uint8Array> => {
  const declared = tableOf(open, table);
  const fields = Object.keys(declared.fields);
  let started = false;
  let cursor: string | null = null;
  let count = 0;
  // What its pages read of a sensitive table, kept once as it ends: read
  // through, failed or let go of by the client. (`app.data.exported`,
  // kept before anything was read, names the export whatever comes of it.)
  const reached: Reached = new Map();
  let kept = false;
  const end = async (): Promise<void> => {
    if (!kept) {
      kept = true;
      await keep(reached);
    }
  };
  // A cancel can land while a pull is under way, its page being read: no
  // pull starts once the client let go, and the cancel waits for the one
  // under way to settle before keeping, so a page it read is counted
  // rather than read after the record was kept.
  let cancelled = false;
  let pulling: Promise<void> = Promise.resolve();
  const step = async (
    controller: ReadableStreamDefaultController<Uint8Array>
  ): Promise<void> => {
    if (cancelled) {
      return;
    }
    try {
      // Every page of the version its header named, or none: one made
      // current meanwhile stops it rather than mixing two.
      const now = await recheck();
      if (now.version !== open.version) {
        throw appDataErrors.create("app_data.version_changed");
      }
      // Their teams too: a page is read under the teams they are in
      // now, and a team lost or joined meanwhile stops the export
      // rather than go on through rows chosen under the old ones.
      requireSameTeams(open, now, table);
      if (!started) {
        started = true;
        controller.enqueue(
          encoder.encode(csvLine([idColumn, ...fields].map(quotedText)))
        );
        return;
      }
      if (cancelled) {
        return;
      }
      const page = await readPage(now, table, queryMaxResults, cursor, reached);
      if (cancelled) {
        // Let go of meanwhile: the cancel keeps what this page read,
        // once this settles, and nothing more is sent.
        return;
      }
      count += page.records.length;
      if (count > appDataExportMaxRecords) {
        throw appDataErrors.create("app_data.export_too_large");
      }
      const lines = page.records.map((record) =>
        csvLine([
          quotedText(record.id),
          ...fields.map((field) =>
            fieldCell(
              declared.fields[field],
              Object.hasOwn(record.fields, field)
                ? record.fields[field]
                : undefined
            )
          ),
        ])
      );
      if (lines.length > 0) {
        controller.enqueue(encoder.encode(lines.join("")));
      }
      ({ cursor } = page);
      if (cursor === null) {
        await end();
        controller.close();
      }
    } catch (error) {
      if (cancelled) {
        return;
      }
      await end();
      controller.error(error);
    }
  };
  return new ReadableStream<Uint8Array>(
    {
      cancel: async () => {
        cancelled = true;
        await pulling;
        await end();
      },
      pull: async (controller) => {
        pulling = step(controller);
        await pulling;
      },
    },
    // Nothing is read ahead: a page is read only when the client asks.
    { highWaterMark: 0 }
  );
};

/**
 * An App's data over `/rpc`, for its builders and the admins
 * (`AppDataApi`). Every method checks the session and the person's role
 * in the App first.
 */
export class AppDataRpc extends CoreRpcTarget implements AppDataApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async tables(app: string): Promise<AppDataTables> {
    return await withPerson(this.#check, async (by) => {
      const { store } = await opened(this.#env, by, app);
      return store === undefined
        ? { version: null, tables: [] }
        : {
            version: store.version,
            tables: Object.entries(store.tables).map(
              tableView(new Set(await store.store.sensitiveTables()))
            ),
          };
    });
  }

  async records(
    app: string,
    table: string,
    version: number,
    cursor: string | null
  ): Promise<AppDataPage> {
    return await withPerson(this.#check, async (by) => {
      const open = await versionedStore(this.#env, by, app, version);
      tableOf(open, table);
      if (cursor !== null && typeof cursor !== "string") {
        throw appDataErrors.create("app_data.invalid");
      }
      const reached: Reached = new Map();
      try {
        return await readPage(open, table, appDataPageSize, cursor, reached);
      } finally {
        await keepPageReads(this.#env, by, open, "browser", reached);
      }
    });
  }

  async record(
    app: string,
    table: string,
    version: number,
    id: string
  ): Promise<AppDataRecord | null> {
    return await withPerson(this.#check, async (by) => {
      const open = await versionedStore(this.#env, by, app, version);
      tableOf(open, table);
      const reached: Reached = new Map();
      let value: QueryAnswer;
      try {
        value = await readCounted(
          open,
          { kind: "get", table, id, expectedRevision: null },
          reached
        );
      } finally {
        await keepPageReads(this.#env, by, open, "browser", reached);
      }
      return value === null ? null : recordOf(value);
    });
  }

  async history(
    app: string,
    table: string,
    version: number,
    id: string,
    before: number | null
  ): Promise<RecordChangePage> {
    return await withPerson(this.#check, async (by) => {
      const open = await versionedStore(this.#env, by, app, version);
      tableOf(open, table);
      return await open.store.history(open.scope, table, id, before);
    });
  }

  async export(
    app: string,
    table: string
  ): Promise<ReadableStream<Uint8Array>> {
    return await withPerson(this.#check, async (by) => {
      const open = await openedStore(this.#env, by, app);
      tableOf(open, table);
      await keepAuditEvent(this.#env, drizzle(this.#env.DB), {
        actor: actorOf(by),
        action: "app.data.exported",
        target: { type: "app", id: open.app.id },
        detail: { table, version: open.version },
      });
      return exportStream(
        open,
        table,
        async () =>
          await withPerson(
            this.#check,
            async (now) => await openedStore(this.#env, now, app)
          ),
        async (reached) => {
          await keepPageReads(this.#env, by, open, "export", reached);
        }
      );
    });
  }

  async previewImport(
    app: string,
    table: string,
    csv: string
  ): Promise<AppDataImportPreview> {
    return await withPerson(this.#check, async (by) => {
      const { csv: text } = appDataErrors.parse(
        "app_data.invalid",
        appDataImportSchema,
        { version: 1, csv, mapping: {} }
      );
      const open = await openedStore(this.#env, by, app);
      const declared = tableOf(open, table);
      const read = readCsv(text);
      if ("error" in read) {
        throw appDataErrors.create("app_data.invalid", {
          issues: [read.error],
        });
      }
      return {
        columns: read.columns,
        rows: read.rows.length,
        mapping: suggestedMapping(read.columns, declared),
      };
    });
  }

  async import(
    app: string,
    table: string,
    request: AppDataImport
  ): Promise<AppDataImportResult> {
    return await withPerson(
      this.#check,
      async (by) =>
        await importRows(
          this.#env,
          by,
          app,
          table,
          request,
          async () =>
            await withPerson(
              this.#check,
              async (now) => await openedStore(this.#env, now, app)
            )
        )
    );
  }
}
