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
import type { QueryRequest } from "@grasp-os/shared/store-reads";
import { dataErrors, storedFieldsSchema } from "@grasp-os/shared/stores";
import type { StoreFields } from "@grasp-os/shared/stores";
import { CsvError, parse } from "csv-parse/sync";
import { drizzle } from "drizzle-orm/d1";

import { requireNotArchived } from "./app-access.ts";
import { loadRelease } from "./app-releases.ts";
import { appFor } from "./apps.ts";
import { keepAuditEvent } from "./audit-outbox.ts";
import { openStore } from "./data-stores.ts";
import type { OpenStore } from "./data-stores.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { requireNotStaff } from "./sharing.ts";

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
//   the person with a member's and builder's roles, under the schema of
//   the App's current version, so `none` refuses, and `owner` shows only
//   the person's own records, and history only of those.
// - An import writing what App code couldn't: every row is checked
//   against the table's schema in core first, then lands through the
//   store's own checks for a commit's insert (the table's write access
//   for those roles, IDs not in use, references to records that exist),
//   as new records owned by the importer, recorded in the history as an
//   import by them. An archived App takes none.
// - A half-landed import: rows are checked first, all of them, and any
//   error lands nothing; then the store takes them in batches within one
//   commit's bounds and lands all of them in one transaction, or none.
// - A file too big to hold: bounded by `appDataImportLimits` before it is
//   parsed (its bytes, by the request's schema) and as it is read (rows,
//   columns, errors reported). An export stops past
//   `appDataExportMaxRecords`, never truncating silently.
// - A CSV cell run as a formula where the export is opened: a text cell
//   that a spreadsheet would read as a formula (or that starts with the
//   guard itself) is written with a leading `'`, which an import takes
//   off again, so text round-trips.
// - Bulk reads and writes nobody can trace: each export and import is in
//   the audit log (`app.data.exported`, `app.data.imported`), with the
//   table and how many rows; each record an import inserts is in the
//   store's history.

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

/** One page of `table` as `open` reads it. */
const readPage = async (
  open: Opened,
  table: string,
  size: number,
  cursor: string | null
): Promise<AppDataPage> => {
  const { value } = await open.store.read(open.scope, {
    kind: "query",
    query: pageQuery(table, size, cursor),
  });
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

/**
 * A field's value as a CSV cell's text: text kinds as they are (guarded
 * against formulas), anything else as JSON; undefined for no value.
 */
const cellText = (
  descriptor: ValueDescriptor | undefined,
  value: unknown
): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (descriptor !== undefined && textKinds.has(descriptor.kind)) {
    if (typeof value === "string") {
      return guarded.test(value) ? `'${value}` : value;
    }
    // A text field's null is no value, as an empty cell reads.
    if (value === null) {
      return undefined;
    }
  }
  return JSON.stringify(value);
};

/** One CSV field: empty for no value, quoted when it must be or is empty text. */
const csvField = (text: string | undefined): string => {
  if (text === undefined) {
    return "";
  }
  return text === "" || quotedCell.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
};

const csvLine = (cells: readonly (string | undefined)[]): string =>
  `${cells.map(csvField).join(",")}\r\n`;

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

/** What an import into `table` of `open`'s store does, for `by`. */
const importRows = async (
  env: Env,
  by: Identity,
  input: unknown,
  table: string,
  request: unknown
): Promise<AppDataImportResult> => {
  const { csv, mapping } = appDataErrors.parse(
    "app_data.invalid",
    appDataImportSchema,
    request
  );
  const open = await openedStore(env, by, input);
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
  // Their role read again just before it lands: one lost while the
  // batches went lands nothing.
  const still = await openedStore(env, by, input);
  requireNotArchived(still.app);
  if (still.version !== open.version) {
    throw appDataErrors.create("app_data.invalid");
  }
  try {
    // Its audit event lands with its rows, in the store's transaction:
    // in the log exactly when they are in the store, and once, as a
    // staged import lands once.
    const { inserted } = await open.store.applyImport({
      importId,
      principal: by.userId,
      actor: actorOf(by),
      roles: { appMember: true, appBuilder: true },
      schemaHash: open.scope.schemaHash,
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
 * with `recheck` before every page; recorded before anything is read.
 */
const exportStream = (
  open: Opened,
  table: string,
  recheck: () => Promise<Opened>
): ReadableStream<Uint8Array> => {
  const declared = tableOf(open, table);
  const fields = Object.keys(declared.fields);
  let started = false;
  let cursor: string | null = null;
  let count = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        try {
          const now = await recheck();
          if (!started) {
            started = true;
            controller.enqueue(encoder.encode(csvLine([idColumn, ...fields])));
            return;
          }
          const page = await readPage(now, table, queryMaxResults, cursor);
          count += page.records.length;
          if (count > appDataExportMaxRecords) {
            throw appDataErrors.create("app_data.export_too_large");
          }
          const lines = page.records.map((record) =>
            csvLine([
              record.id,
              ...fields.map((field) =>
                cellText(
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
            controller.close();
          }
        } catch (error) {
          controller.error(error);
        }
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
    cursor: string | null
  ): Promise<AppDataPage> {
    return await withPerson(this.#check, async (by) => {
      const open = await openedStore(this.#env, by, app);
      tableOf(open, table);
      if (cursor !== null && typeof cursor !== "string") {
        throw appDataErrors.create("app_data.invalid");
      }
      return await readPage(open, table, appDataPageSize, cursor);
    });
  }

  async record(
    app: string,
    table: string,
    id: string
  ): Promise<AppDataRecord | null> {
    return await withPerson(this.#check, async (by) => {
      const open = await openedStore(this.#env, by, app);
      tableOf(open, table);
      const { value } = await open.store.read(open.scope, {
        kind: "get",
        table,
        id,
        expectedRevision: null,
      });
      return value === null ? null : recordOf(value);
    });
  }

  async history(
    app: string,
    table: string,
    id: string,
    before: number | null
  ): Promise<RecordChangePage> {
    return await withPerson(this.#check, async (by) => {
      const open = await openedStore(this.#env, by, app);
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
          )
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
        { csv, mapping: {} }
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
      async (by) => await importRows(this.#env, by, app, table, request)
    );
  }
}
