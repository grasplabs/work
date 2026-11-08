import { z } from "zod";

import type { AuditActor } from "./audit.ts";
import { defineErrorFamily } from "./errors.ts";

// An App's data, as its builders and the organization's admins see it from
// the App's page (core's app-data.ts): its tables, their records a page at
// a time, each record's change history, and a table's CSV export and
// import. Read-only but for an import, which writes as the person importing
// it, through the store's own checks, and is recorded as their change.

/**
 * How a record changed: inserted, its fields updated (patched or
 * replaced), or deleted.
 */
export const recordChangeOps = ["insert", "update", "delete"] as const;
export type RecordChangeOp = (typeof recordChangeOps)[number];

/**
 * What made a change: a commit of the App's (or a consumer's) mutation, a
 * cascade of a deletion (in that commit or after it, as the store's
 * cascade job), or an import of a table's CSV. A schema applied as a
 * version is published keeps no change per record: a field it fills in
 * is one audit event (`app.data.filled`, core's store-host.ts), and a
 * migration's transform never moves a field a row rule reads.
 */
export const recordChangeSources = ["commit", "cascade", "import"] as const;
export type RecordChangeSource = (typeof recordChangeSources)[number];

/**
 * Why a change keeps its fields' names but not their values: its table is
 * declared sensitive (`defineTable(...).sensitive()`), the values were
 * larger than a change keeps, the change didn't read them (a cascade job
 * deletes a record without loading it), the person who made it was
 * erased, and what they wrote with them: a record's history as
 * a reader its table's row rules choose rows for reads it stops there,
 * as its states before can't be told.
 */
export const valuesLeftOutReasons = [
  "sensitive",
  "too_large",
  "unread",
  "erased",
] as const;
export type ValuesLeftOut = (typeof valuesLeftOutReasons)[number];

/**
 * One change to one record, as the store recorded it in the transaction
 * that made it: who, when, what, and which fields. `before` and `after`
 * hold the changed fields' values (a field absent on a side is left out
 * of it), unless `valuesLeftOut` says why not.
 */
export interface RecordChange {
  /** Its place in the store's history: later changes have higher ones. */
  id: number;
  at: string;
  table: string;
  record: string;
  op: RecordChangeOp;
  source: RecordChangeSource;
  actor: AuditActor;
  /** The commit it was made in, in the store's order of commits. */
  commit: number | null;
  fields: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  valuesLeftOut: ValuesLeftOut | null;
}

/**
 * How much change history a store keeps: each change for
 * `retentionDays`, and at most `maxEntries` changes and `maxBytes` of
 * them in all, the oldest going first, whichever comes sooner.
 * `valuesMaxBytes` bounds the values one change keeps, before and after
 * together.
 */
export const recordChangeLimits = {
  retentionDays: 90,
  maxEntries: 100_000,
  maxBytes: 64 * 1024 * 1024,
  valuesMaxBytes: 16 * 1024,
  /** Most changes one read of a record's history answers. */
  pageSize: 50,
} as const;

/** A field of a table, as the data browser shows and an import maps it. */
export interface AppDataField {
  name: string;
  /** Its value's kind (`string`, `number`, `object`, …), from its descriptor. */
  kind: string;
  /** Whether a record must hold it: neither optional nor defaulted. */
  required: boolean;
}

/** Who reads and writes a table's records (its schema's access modes). */
export type AppDataAccess = "owner" | "appMembers" | "appBuilders" | "none";

/** A table of an App's current version, as the data browser lists it. */
export interface AppDataTable {
  name: string;
  read: AppDataAccess;
  write: AppDataAccess;
  sensitive: boolean;
  fields: AppDataField[];
  /**
   * How many records it holds, kept by the store with every write; null
   * where the browser shows each person only some of them (an owner
   * table, or one with row rules).
   */
  records: number | null;
}

/**
 * An App's tables, as its current version declares them; none (and
 * `version` null) for an App with no current version, or one with no
 * store.
 */
export interface AppDataTables {
  version: number | null;
  tables: AppDataTable[];
}

/** A record as the data browser shows it. */
export interface AppDataRecord {
  id: string;
  owner: string;
  createdAt: string;
  updatedAt: string;
  /** Its fields; typed loosely, as RPC types can't carry JSON deeply. */
  fields: Record<string, unknown>;
}

/** A page of a table's records, newest first, and the cursor to the next. */
export interface AppDataPage {
  records: AppDataRecord[];
  cursor: string | null;
}

/** A page of a record's history, newest first, and where the next starts. */
export interface RecordChangePage {
  changes: RecordChange[];
  /** Pass as `before` to read on; null once there is no more. */
  next: number | null;
}

/**
 * How big a CSV import may be. One import lands in one transaction of the
 * store, all of it or nothing, so it is bounded: at most `maxRows` rows
 * and `maxBytes` of CSV. The store takes it in batches of at most
 * `batchRows` rows first, each within one commit's bounds.
 */
export const appDataImportLimits = {
  maxRows: 2000,
  maxBytes: 4 * 1024 * 1024,
  batchRows: 100,
  /** Most row errors one import reports. */
  maxErrors: 100,
  maxColumns: 256,
} as const;

/** Most records one CSV export holds. */
export const appDataExportMaxRecords = 50_000;

/** Records one page of the data browser holds. */
export const appDataPageSize = 50;

/** A CSV's columns, and how an import would map them. */
export interface AppDataImportPreview {
  columns: string[];
  /** Rows after the header. */
  rows: number;
  /** For each column, the field of the same name, or null. */
  mapping: Record<string, string | null>;
}

/** What to import: the CSV's text, and each column's field (null: left out). */
export const appDataImportSchema = z.strictObject({
  /** The version whose tables the person mapped the columns to (`tables`). */
  version: z.int().min(1),
  csv: z.string().max(appDataImportLimits.maxBytes),
  mapping: z
    .record(z.string().max(256), z.string().max(64).nullable())
    .refine(
      (mapping) => Object.keys(mapping).length <= appDataImportLimits.maxColumns
    ),
});
export type AppDataImport = z.infer<typeof appDataImportSchema>;

/** One thing wrong with an import: its row (1 is the first after the header). */
export interface AppDataImportError {
  /** 0 for what is wrong with the file as a whole. */
  row: number;
  column: string | null;
  field: string | null;
  message: string;
}

/** What an import did: everything landed, or nothing did, and why. */
export type AppDataImportResult =
  | { ok: true; inserted: number }
  | { ok: false; errors: AppDataImportError[]; more: boolean };

export const appDataErrors = defineErrorFamily({
  "app_data.no_table": "This App's current version has no such table.",
  "app_data.invalid": "That isn't a valid request for this App's data.",
  "app_data.export_too_large": `A table exports at most ${appDataExportMaxRecords} records.`,
  "app_data.version_changed":
    "This App changed. Reload to see its current version.",
  "app_data.access_changed":
    "Your teams changed while this ran, so the rows you may reach did too. Start it again.",
});

/** An App's data, through `apps.data`: for its builders and the admins. */
export interface AppDataApi {
  /** The tables of the App's current version. */
  tables: (app: string) => Promise<AppDataTables>;
  /**
   * A page of `table`'s records, newest first, as the person may read
   * them (the table's read access): from `cursor`, the last page's. Like
   * `record`, `history` and `import`, it names the version whose tables
   * the page read (`tables`): refused (`app_data.version_changed`) once
   * another is current, never read under the other's tables.
   */
  records: (
    app: string,
    table: string,
    version: number,
    cursor: string | null
  ) => Promise<AppDataPage>;
  /** One record, as `records` would show it; null when there is none. */
  record: (
    app: string,
    table: string,
    version: number,
    id: string
  ) => Promise<AppDataRecord | null>;
  /**
   * A page of the history of `table`'s record `id`, newest first, before
   * change `before` if given. Only of a record the person may read.
   */
  history: (
    app: string,
    table: string,
    version: number,
    id: string,
    before: number | null
  ) => Promise<RecordChangePage>;
  /**
   * `table` as CSV, as the person may read it: a header of `_id` and its
   * fields, then a record a row, streamed, every page of the version the
   * export began on (`app_data.version_changed` once another is made
   * current). In a field of any kind, an empty unquoted cell is no value
   * and the unquoted cell `null` is null; a text field's text is as it is
   * (a leading `'` guarding a formula), quoted when empty or when it reads
   * `null`; any other value is JSON. An import reads it back as it was.
   * Recorded in the audit log before anything is read; stops
   * (`app_data.export_too_large`) past `appDataExportMaxRecords`.
   */
  export: (app: string, table: string) => Promise<ReadableStream<Uint8Array>>;
  /** A CSV's columns, how many rows it has, and the fields they'd fill. */
  previewImport: (
    app: string,
    table: string,
    csv: string
  ) => Promise<AppDataImportPreview>;
  /**
   * Inserts the CSV's rows into `table` as new records of the person's,
   * each column into the field `mapping` names: every row checked against
   * the table's schema first, and all of them land, in one transaction, or
   * none do, with each row's errors.
   */
  import: (
    app: string,
    table: string,
    request: AppDataImport
  ) => Promise<AppDataImportResult>;
}
