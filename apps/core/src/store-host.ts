import { ValueDefinitionError } from "@grasp-os/sdk";
import type { ValueDescriptor } from "@grasp-os/sdk";
import {
  descriptorFromText,
  holdsReference,
  manifestText,
  planPreferenceChange,
  readSchemaManifest,
  referencesRenamed,
  SchemaDefinitionError,
  schemaHash as hashOf,
} from "@grasp-os/sdk/host";
import type {
  ManifestTable,
  PreferencesContract,
  ReadManifest,
  SchemaAnswer,
  SchemaManifest,
} from "@grasp-os/sdk/host";
import { appDataImportLimits } from "@grasp-os/shared/app-data";
import type { RecordChangePage } from "@grasp-os/shared/app-data";
import {
  auditActorSchema,
  auditEventSchema,
  auditProvenanceMaxItems,
} from "@grasp-os/shared/audit";
import type { AuditActor, AuditEvent } from "@grasp-os/shared/audit";
import { sha256Hex, toHex } from "@grasp-os/shared/encoding";
import { identifierSchema, storeIdSchema } from "@grasp-os/shared/ids";
import type { StoreId } from "@grasp-os/shared/ids";
import { canonicalJson, canonicalText, isRecord } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { stableIdPattern, storeMaxTables } from "@grasp-os/shared/store-limits";
import {
  readRequestSchema,
  readScopeSchema,
} from "@grasp-os/shared/store-queries";
import type { ReadScope } from "@grasp-os/shared/store-queries";
import type { QueryRequest, ReadRequest } from "@grasp-os/shared/store-reads";
import {
  claimSchema,
  commitSchema,
  cascadeJobMaxRecords,
  commitMaxCascade,
  committedSchema,
  dataErrors,
  documentMaxBytes,
  migrationErrors,
  recordIdSchema,
  stagedWritesSchema,
  storeIntentSchema,
  receiptScopeSchema,
  schemaAnswerSchema,
  schemaAnswersMax,
  storedFieldsSchema,
  tableNameSchema,
  writerRolesSchema,
} from "@grasp-os/shared/stores";
import type {
  ClaimInput,
  Claimed,
  Commit,
  Committed,
  StagedWrites,
  StoreFields,
  StoredRecord,
  WriterRoles,
} from "@grasp-os/shared/stores";
import {
  submissionErrors,
  submissionRetentionDays,
  submissionTombstoneDays,
} from "@grasp-os/shared/submissions";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  min,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import {
  cascadeJobs,
  cascadeMembers,
  fileEvents,
  files,
  importRows,
  migrationRows,
  outbox,
  preferences,
  receipts,
  recordChanges,
  recordRefs,
  records,
  store,
  tables,
} from "./db/data-store/schema.ts";
import { FileHost } from "./file-host.ts";
import type { FileHolder, FileReader } from "./file-host.ts";
import { liveRuns } from "./live-runs.ts";
import {
  assertTimeout,
  backoffMs,
  consumerFor,
  defaultBudgetMs,
  defaultMaxAttempts,
  defaultTimeoutMs,
  handOver,
} from "./outbox-delivery.ts";
import type { DrainOptions, OutboxConsumers } from "./outbox-delivery.ts";
import { planSchemaChange } from "./schema-changes.ts";
import type {
  CatalogTable,
  HeldSchema,
  PlannedFill,
  PlannedRename,
  SchemaChangePlan,
} from "./schema-changes.ts";
import {
  historyDueAt,
  admittedHistoryOf,
  historyOf,
  pruneHistory,
  recordChangesIn,
  renameHistoryFields,
} from "./store-changes.ts";
import type { ChangeInput } from "./store-changes.ts";
import { decodeCursor, encodeCursor } from "./store-cursors.ts";
import type { CursorBinding } from "./store-cursors.ts";
import { inventoriedDeleted, recordStoreDeleted } from "./store-deletion.ts";
import type { StoreDeletionMark } from "./store-deletion.ts";
import type { Fragment } from "./store-expressions.ts";
import { dropIndexes, installIndexes, planIndexes } from "./store-indexes.ts";
import {
  pagePlans,
  planQuery,
  readableTable,
  readPage,
  relatedTables,
  readRecord,
  runQuery,
} from "./store-queries.ts";
import type {
  Anchor,
  PageAnswer,
  PinnedSchema,
  QueryAnswer,
  ReadSql,
} from "./store-queries.ts";
import { recordReferences } from "./store-references.ts";
import {
  audienceOf,
  fieldsRead,
  ruleFieldsOf,
  ruleSql,
} from "./store-rules.ts";
import type { Audience, RuleCaller } from "./store-rules.ts";
import {
  dropSearches,
  installSearches,
  planSearches,
  searchObjectsLeft,
} from "./store-search.ts";

// The host of a business store (data-store.ts is its Durable Object): one
// object per store, named by the store's ID (data-stores.ts), with a
// SQLite database of its own that holds all of the store's logical tables
// and their records. The layout is the host's and fixed
// (db/data-store/schema.ts): a table is a row under the stable ID its
// App's definition gives it, a record a row with its managed fields in
// columns and its declared fields in one JSON document. No name an author
// chose ever becomes SQL: tables are found by ID, values are bound
// parameters.
//
// A store holds one schema, its App's current version's, applied as that
// version is published (`applySchema`, schema-changes.ts): every read and
// write runs under it, and one pinned to any other is refused
// (`migration.not_current`).
//
// Only core holds this object's stub (`DATA_STORES` is one of core's own
// bindings, which App and workflow code never get), and core reaches it
// only for a store its inventory lists. Each deployment's core has a
// namespace of these objects of its own, so stores of two deployments
// never meet, whatever their names.
//
// A commit is one synchronous transaction: every revision guard and
// write checks against the store as it is, and all of the commit's
// writes land, or none do. Multiple writes to one record in a commit
// change its revision once; a record inserted in the commit is at
// revision 1 until it commits. A commit that changes nothing in a record
// leaves its revision and update time as they were.
//
// Every commit is made under a receipt (`sdk_mutation_receipts`), which
// the attempt claims before its handler runs, and the commit writes its
// outcome and its outbox entries in the same transaction as its records.
// One object's transaction is all the fencing they need. Threat model, and
// how each is closed:
//
// - A stale attempt commits after a newer one began: every claim moves
//   the receipt's fence on, and a commit is refused
//   (`submission.superseded`) unless it holds the current fence, checked
//   in its transaction. Every attempt under a receipt has the same input
//   (other input is refused at the claim), so an attempt that finds its
//   mutation committed by another answers that outcome.
// - A call is killed, or times out, after its handler staged its writes:
//   nothing is written before the commit, and the commit checks the
//   attempt's deadline by this object's clock, in its transaction
//   (`submission.deadline_passed`). A killed attempt's claim only holds
//   the key; the next attempt claims again and commits once.
// - A commit's answer is lost, then retried: the retry's claim finds the
//   outcome and answers it, writing nothing.
// - A key is reused with other input: `submission.key_conflict`; a key
//   whose receipt expired is `submission.expired` while its tombstone is
//   kept.
// - A key crosses callers or operations: a receipt's ID hashes the store,
//   the whole scope (person, resource, binding, contract and its version,
//   operation kind) and the key, and a commit is refused unless its
//   principal is the receipt's.
// - A receipt expires under a commit: every claim keeps it a retention
//   from then, and the commit another from the commit; a receipt whose
//   outbox still owes an entry, or whose run is live, is never expired.
// - An outbox entry is lost or handed over twice: it commits with its
//   records, stays until settled, is leased before each hand-over and
//   settled only by the lease holder, and keeps one ID however often it is
//   handed over: a drain that dies mid-way, or stalls past its lease (a
//   starved isolate, a slow write), leaves the lease to run out, and the
//   entry is handed over again under that ID, while the drain that lost the
//   lease settles nothing. A kind nothing takes can't be staged; one whose
//   consumer is gone fails its attempts like any hand-over, so a rollback
//   doesn't drop it, and is settled as `outbox.no_consumer` once they run
//   out, so it doesn't keep its receipt forever. Every commit gives its
//   entries IDs of their own (its number in the store's order), so a key
//   that commits again after its tombstone went never reuses one.
// - A live query misses a write: every write that moves a table's
//   generation (a commit, a schema change that rewrote records) tells
//   `onTablesMoved` once its transaction is over; a write the object
//   died before telling is found by core's periodic `rewatch`, which
//   compares generations (query-subscriptions.ts).
// - The alarm spins, or stops: it is set only for what it can act on (an
//   owed entry, a receipt the sweep may expire, a tombstone), never
//   sooner than a second away, again after work that failed (a while
//   later), and on every wake-up, so a commit whose object died before
//   setting it is still drained. Its drain and sweep are each bounded in
//   time; the next alarm continues.
// - A schema is crafted to break the host, or to pass for another: the
//   manifest is read as untrusted text (bounded, strict, declared again
//   through the SDK's own checks, sdk/src/schema-manifest.ts), and its
//   hash is computed here from its canonical text, never taken as given.
// - A caller bends time or delivery: the object's RPC methods take no
//   clock, consumers or budget; only tests choose them, through this host
//   inside the object.

/**
 * `read()`, with SQLite's refusal of an index it doesn't hold (one an
 * older layout or a damaged store lacks) as `data.index_required`, never
 * a scan.
 */
const indexRequired = <Answer>(read: () => Answer): Answer => {
  try {
    return read();
  } catch (error) {
    // SQLite's own error, never one of the store's (whose messages may
    // say as much).
    if (
      error instanceof Error &&
      dataErrors.codeOf(error) === undefined &&
      /no such index/u.test(error.message)
    ) {
      // A store whose indexes don't match its schemas needs looking at.
      log.error("store.index_missing", errorFields(error));
      throw dataErrors.create("data.index_required");
    }
    throw error;
  }
};

/**
 * What a read answers: its value, the generation of the table it read,
 * at the moment it read it (`sdk_tables.generation`), and how many
 * records it answered of each sensitive table it read
 * (`StoreHost.#readIn`).
 */
export interface ReadResult {
  value: QueryAnswer;
  generations: Record<string, number>;
  sensitive: Record<string, number>;
}

/** A store's record, as staged in a commit. */
interface Staged {
  /** Its table's name, for what a refusal says. */
  table: string;
  tableId: string;
  recordId: string;
  /** The row as committed before this commit; none for a record it inserted. */
  base: typeof records.$inferSelect | undefined;
  /** Its fields as staged so far; null once the commit deleted it. */
  fields: StoreFields | null;
  /** Whether a cascade deleted it (`#cascade`), not one of the commit's writes. */
  cascaded?: true;
}

/** A record a cascade job deletes. */
interface CascadeMember {
  readonly tableId: string;
  readonly recordId: string;
}

/** A cascade past one commit's bound, as its commit plans it (`#cascade`). */
interface CascadePlan {
  /** The first record the commit itself deleted. */
  readonly root: CascadeMember;
  /** Every record it deletes, the commit's own deletions included, by key. */
  readonly members: ReadonlyMap<string, CascadeMember>;
}

/** Who starts a cascade job, from which commit, and when. */
interface CascadeStart {
  readonly receiptId: string;
  readonly principal: string;
  /**
   * The resource the commit came through, as its receipt's scope names it:
   * the App whose release committed, or the consumer that called.
   */
  readonly resourceId: string | null;
  /** The workflow run the commit was made in, if any. */
  readonly runId: string | null;
  /** Who made the commit: whom its deletions' change history names. */
  readonly actor: AuditActor;
  readonly now: number;
}

/**
 * `admits`, asked once for each distinct value of the fields `table`'s
 * read rules read: the states a history is rebuilt through mostly share
 * them, so a record with a long history costs a check per team or
 * assignee it had, not per change.
 */
const admittedOnce = (
  table: ManifestTable,
  admits: (fields: StoreFields) => boolean
): ((fields: StoreFields) => boolean) => {
  const ruleFields = fieldsRead(table.rules?.read);
  const known = new Map<string, boolean>();
  return (fields) => {
    const key = canonicalJson(
      ruleFields.map((field) =>
        Object.hasOwn(fields, field) ? (fields[field] ?? null) : null
      )
    );
    const answer = known.get(key) ?? admits(fields);
    known.set(key, answer);
    return answer;
  };
};

/** Where a staged record is kept: its table and ID, which can't collide. */
const keyOf = (tableId: string, recordId: string): string =>
  JSON.stringify([tableId, recordId]);

/** A record's fields as stored: canonical, so equal fields store equal text. */
const storedText = (fields: StoreFields): string => canonicalJson(fields);

/** The fields a row stores. Its JSON is an object, as SQLite checks. */
const fieldsOf = (row: { valueJson: string }): StoreFields =>
  storedFieldsSchema.parse(JSON.parse(row.valueJson));

const toStored = (row: typeof records.$inferSelect): StoredRecord => ({
  id: row.recordId,
  ownerId: row.ownerId,
  revision: row.revision,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  schemaHash: row.schemaHash,
  fields: fieldsOf(row),
});

const encoder = new TextEncoder();

const dayMs = 24 * 60 * 60 * 1000;

/** How long a receipt is kept from each claim, and from its commit. */
const retentionMs = submissionRetentionDays * dayMs;

/** How long a tombstone is kept, so a key reused late is refused as expired. */
const tombstoneMs = submissionTombstoneDays * dayMs;

/** How much later a receipt kept for its live run is looked at again. */
const liveRunRecheckMs = dayMs;

/** Most receipts, tombstones or outbox entries one pass reads at a time. */
const page = 100;

/** A cascade job's row. */
type CascadeJob = typeof cascadeJobs.$inferSelect;

/** Whether `manifest` declares its table `table` sensitive. */
const declaredSensitive = (
  manifest: SchemaManifest | undefined,
  table: string
): boolean =>
  manifest !== undefined &&
  Object.hasOwn(manifest.tables, table) &&
  manifest.tables[table]?.sensitive === true;

/** A staged record as its change history records it (store-changes.ts). */
const changeInputOf = (
  entry: Staged,
  sensitive: (table: string) => boolean
): ChangeInput => ({
  tableId: entry.tableId,
  tableName: entry.table,
  recordId: entry.recordId,
  before: entry.base === undefined ? undefined : fieldsOf(entry.base),
  after: entry.fields,
  sensitive: sensitive(entry.table),
});

/** How long an import's staged rows wait to land before a later import drops them. */
const importStagedMs = 60 * 60 * 1000;

/** One batch of an import's rows, as core stages them (`stageImport`). */
const importBatchSchema = z.strictObject({
  importId: z.uuid(),
  principal: identifierSchema,
  table: tableNameSchema,
  /** Where the batch's first row is among the import's rows. */
  from: z.int().min(0).max(appDataImportLimits.maxRows),
  rows: z
    .array(z.strictObject({ id: recordIdSchema, fields: storedFieldsSchema }))
    .min(1)
    .max(appDataImportLimits.batchRows),
});
export type ImportBatch = z.input<typeof importBatchSchema>;

/** An import landing (`applyImport`): whose, as whom, under which schema. */
const importApplySchema = z.strictObject({
  storeId: storeIdSchema,
  importId: z.uuid(),
  principal: identifierSchema,
  actor: auditActorSchema,
  roles: writerRolesSchema,
  schemaHash: z.string().regex(/^[0-9a-f]{64}$/u),
  /** How many rows core staged: all of them must be there. */
  rows: z.int().min(1).max(appDataImportLimits.maxRows),
  /** What its audit event names: the App, its version and the table. */
  audit: z.strictObject({
    app: identifierSchema,
    version: z.int().min(1),
    table: tableNameSchema,
  }),
});
export type ImportApply = Omit<z.input<typeof importApplySchema>, "storeId">;

/** A member of a cascade batch, with its record's owner; null once gone. */
interface CascadeBatchMember extends Record<string, SqlStorageValue> {
  tableId: string;
  recordId: string;
  ownerId: string | null;
}

/**
 * Whether another record refers to cascade member `m`, as SQL: a member
 * that is no leaf yet (`#cascadeBatchOf`).
 */
const referredSql = `EXISTS (SELECT 1 FROM sdk_record_refs r
  WHERE r.to_table_id = m.table_id AND r.to_record_id = m.record_id
    AND NOT (r.table_id = m.table_id AND r.record_id = m.record_id))`;

/**
 * The fewest leaves a cascade batch takes alone: below it, the batch is
 * filled up by cutting cycles and chains (`#cascadeBatchOf`).
 */
const cascadeLeavesAtLeast = 25;

/**
 * The stored record a cascade batch deletes, as far as a deletion reads
 * it (`#flush`, `FileHost.index`): that it is there, and whose it is. Its
 * document is never loaded, and a deletion never reads it.
 */
const deletedBase = (
  tableId: string,
  recordId: string,
  ownerId: string
): typeof records.$inferSelect => ({
  tableId,
  recordId,
  ownerId,
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  valueJson: "{}",
  schemaHash: "",
});

/** A committed receipt's outcome, which `commit` wrote from a `Committed`. */
const outcomeOf = (stored: string): Committed =>
  committedSchema.parse(JSON.parse(stored));

/**
 * The resource a receipt's scope names (stored as JSON): what a commit
 * made under it came through, for its cascade job's audit events.
 */
const resourceOfScope = (scope: string): string | null => {
  try {
    return (
      receiptScopeSchema.safeParse(JSON.parse(scope)).data?.resource ?? null
    );
  } catch {
    return null;
  }
};

/** Whether a receipt's outbox owes no entry, which the sweep requires. */
const nothingOwed = sql`NOT EXISTS (SELECT 1 FROM ${outbox} WHERE ${outbox.receiptId} = ${receipts.receiptId} AND ${outbox.settledAt} IS NULL)`;

/** How long a sweep goes on taking pages, at most. */
const sweepBudgetMs = 20_000;

/** Most records a deleted store's purge removes in one transaction. */
const purgePage = 1000;

/**
 * What a live read of one person's preferences watches, as if a table:
 * `~preferences/<person>`, whose generation is that person's revision
 * (`sdk_preferences.revision`, 0 for none). Per person, so one person's
 * write tells only the reads of their own preferences: nobody else's
 * page hears of it, or spends its budget reading again. `~` starts no
 * table name an author can give (`tableNameSchema`), so it never names one.
 */
const preferencesWatchPrefix = "~preferences/";

/** What a live read of `personId`'s preferences watches. */
export const preferencesWatch = (personId: string): string =>
  `${preferencesWatchPrefix}${personId}`;

/** Most people's preferences one read set watches: a read watches one. */
const preferencesWatchMax = 4;

/** A release's preferences, from their descriptor's JSON (`data.invalid`). */
const declaredPreferences = (preferencesText: string): ValueDescriptor => {
  try {
    return descriptorFromText(preferencesText);
  } catch {
    throw dataErrors.create("data.invalid");
  }
};

/** Whose preferences: a person's ID as core's sessions name them. */
const personIdOf = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\w-]+$/u);

/** What the store keeps of one of its tables (`tableFacts`). */
export interface TableFacts {
  readonly sensitive: boolean;
  readonly records: number;
}

/** A person's preferences as stored (`readPreferences`). */
export interface StoredPreferences {
  readonly valueJson: string | null;
  readonly revision: number;
  readonly lastKey: string | null;
  readonly lastInputHash: string | null;
  readonly lastAnswerJson: string | null;
}

/** What a keyed preferences write keeps for a resend of it. */
export interface PreferencesReceipt {
  readonly key: string;
  readonly inputHash: string;
  readonly answerJson: string;
}

const preferencesReceiptSchema = z.strictObject({
  key: z.string().min(1).max(128),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/u),
  answerJson: z.string(),
});

/** What a preferences write did (`writePreferences`). */
export type PreferencesWritten =
  | { readonly revision: number }
  | { readonly replay: string }
  | { readonly keyConflict: true }
  | { readonly conflict: true };

/** How long one alarm goes on purging before the next one continues. */
const purgeBudgetMs = 10_000;

/**
 * What a deleted store's purge removes, in this order: each table only
 * once nothing refers to its rows (records name tables, entries receipts).
 * Fixed names, never an author's.
 */
const purgedTables = [
  "sdk_file_refs",
  "sdk_file_delete_keys",
  "sdk_file_chunks",
  "sdk_file_writes",
  "sdk_file_events",
  "sdk_files",
  "sdk_record_refs",
  "sdk_records",
  "sdk_search_docs",
  "sdk_schemas",
  "sdk_schema_backfills",
  "sdk_reserved_fields",
  "sdk_abandoned_targets",
  "sdk_change_outbox",
  "sdk_commit_writers",
  "sdk_cascade_members",
  "sdk_cascade_jobs",
  "sdk_mutation_receipts",
  "sdk_preferences",
  "sdk_record_changes",
  "sdk_rules_owed",
  "sdk_import_rows",
  "sdk_migration_rows",
  "sdk_tables",
] as const;

/**
 * What a reset of the store's data removes (`StoreHost.resetData`), in
 * this order: what refers to records first, tables last.
 */
const resetTables = [
  "sdk_change_outbox",
  "sdk_mutation_receipts",
  "sdk_commit_writers",
  "sdk_file_refs",
  "sdk_record_refs",
  "sdk_cascade_members",
  "sdk_cascade_jobs",
  "sdk_search_docs",
  "sdk_record_changes",
  "sdk_import_rows",
  "sdk_migration_rows",
  "sdk_records",
  "sdk_tables",
] as const;

/**
 * A form's intent without what the form sent (`app.form_sent`, core's
 * app-webhook-queue.ts): its values are kept only to hand them to the
 * App's webhooks, and may hold fields no record keeps.
 */
const formValuesCleared = sql`json_set(${outbox.intent}, '$.data.values', json('null'))`;

/**
 * A send to people without what it said (`app.notify`, core's
 * app-notifications.ts): its title and body are kept only to tell them,
 * and the notifications they got hold them from then on.
 */
const notificationCleared = sql`json_set(${outbox.intent}, '$.data.notification', json('null'))`;

/**
 * An entry's intent once it is settled: a form's without its values, and
 * a send to people without what it said, as nothing hands either over
 * again; any other's as it was.
 */
const settledIntent = sql`CASE ${outbox.kind}
  WHEN 'app.form_sent' THEN ${formValuesCleared}
  WHEN 'app.notify' THEN ${notificationCleared}
  ELSE ${outbox.intent} END`;

/** How long one alarm goes on deleting cascade jobs' batches. */
const cascadeBudgetMs = 5000;

/**
 * The most cascade batches one alarm deletes: the alarm comes again at
 * once for the rest, so other work (the outbox, the sweeps) is never held
 * up for long.
 */
const cascadeBatchesPerAlarm = 10;

/**
 * How often in a row a cascade job's batch may fail before the job fails:
 * audited (`store.cascade_failed`), set aside while the store's other jobs
 * go on, and tried again `cascadeFailedRetryMs` later. Its records stay
 * deleting meanwhile: a batch may have cut references among them
 * (`#cascadeBatchOf`), which only finishing the job makes whole again.
 */
const cascadeJobMaxAttempts = 3;

/** Most referring records a cascade job's plan reads at a time. */
const cascadePlanPage = 1000;

/** How long a failed cascade job is set aside before it is tried again. */
const cascadeFailedRetryMs = dayMs;

/** The most refused changes a refusal lists. */
const refusalsListed = 50;

/** The least wait before the alarm comes again, so it never spins. */
const alarmGapMs = 1000;

/** The wait before the alarm tries again after its work failed. */
const alarmRetryMs = 30_000;

/** A stored intent, or undefined if it no longer reads as one. */
const intentOf = (stored: string) => {
  let json: unknown = null;
  try {
    json = JSON.parse(stored);
  } catch {
    // Not JSON: unreadable, as below.
  }
  return storeIntentSchema.safeParse(json).data;
};

/** A deleted store's mark, as its row holds it. */
const markOf = (row: {
  deletedAt: number | null;
  deletedBy: string | null;
}): StoreDeletionMark => {
  if (row.deletedAt === null || row.deletedBy === null) {
    throw new Error("A deleted store has no deletion mark");
  }
  return {
    deletedAt: row.deletedAt,
    deletedBy: auditActorSchema.parse(JSON.parse(row.deletedBy)),
  };
};

/**
 * The schema a manifest's text declares, read as an untrusted manifest;
 * `data.invalid_schema`, with the check's code, if it fails one.
 */
const readSchema = (manifest: string): ReadManifest => {
  // What a refusal says goes back to the caller as its issue. Neither error
  // repeats what was submitted: a descriptor's refusals name no value (a
  // default included), and a manifest's quote only names that are valid.
  try {
    // It refuses anything but text itself: what crossed RPC may be other.
    return readSchemaManifest(manifest);
  } catch (error) {
    if (
      error instanceof SchemaDefinitionError ||
      error instanceof ValueDefinitionError
    ) {
      throw dataErrors.create("data.invalid_schema", {
        code: error.code,
        issues: [error.message],
      });
    }
    throw error;
  }
};

const conflict = (table: string, id: string) =>
  dataErrors.create("data.conflict", { table, id });

/**
 * How far ahead of this object's clock a commit's staging time may be:
 * core's clock and the object's are the platform's, and differ by far
 * less; a time further ahead is refused rather than stamped on records.
 */
const stagedAheadMs = 60_000;

/** One write a commit or a preview applies, as checked. */
type StoredWrite = z.output<typeof stagedWritesSchema>["writes"][number];

/** A preview's staged writes, as checked. */
type Preview = z.output<typeof stagedWritesSchema>;

/** How a deleted store's purge goes, which tests choose. */
export interface PurgeOptions {
  /** Rows per transaction. */
  page?: number;
  /** How long one alarm goes on purging. */
  budgetMs?: number;
}

/** What a sweep depends on, which tests choose. */
export interface SweepOptions {
  /** How long it goes on taking pages; the next alarm continues. */
  budgetMs?: number;
  /** Which runs of those named are live. */
  live?: (runIds: readonly string[]) => Promise<Set<string>>;
}

/**
 * A store's object, as the host's code works on it: the store's
 * operations with what they depend on passed in (who takes outbox
 * entries, the clock, the live-run lookup). The Durable Object
 * (`DataStore`) fixes those to the deployment's registry and the real
 * clock; tests choose them, inside the object. Not a Durable Object
 * itself, so none of this is reachable over RPC.
 */
/** A schema hash: SHA-256, lower-case hex. */
const schemaHashSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/** A version's schema, as a publish applies it (`StoreHost.applySchema`). */
const schemaApplySchema = z.strictObject({
  /** The schema's manifest, as text. */
  manifest: z.string(),
  /** Its stable IDs, from the App's definition (schema-changes.ts). */
  ids: z.record(
    tableNameSchema,
    z.strictObject({
      id: z.string().min(1).max(64),
      fields: z.record(z.string(), z.string().min(1).max(64)),
    })
  ),
  answers: z.array(schemaAnswerSchema).max(schemaAnswersMax).default([]),
  /** Who publishes: whom the audit log names for what it fills in. */
  actor: auditActorSchema,
  /** The version published, and the one current as its publish began. */
  version: z
    .strictObject({
      app: identifierSchema,
      number: z.int().min(1),
      basedOn: z.int().min(1).nullable(),
    })
    .optional(),
  /**
   * Only while the schema in force is the one applied at this time: a
   * publish putting back the current version's schema over its own, which
   * another publish of the same version may have applied again since.
   */
  onlyIfAppliedAt: z.int().min(0).optional(),
  /** The migration whose output is staged, and the tables it transforms. */
  migration: z
    .strictObject({
      id: z.uuid(),
      from: schemaHashSchema,
      tables: z.array(tableNameSchema).max(storeMaxTables),
    })
    .optional(),
});
export type SchemaApply = Omit<z.input<typeof schemaApplySchema>, "answers"> & {
  readonly answers?: readonly SchemaAnswer[];
};

/** What applying a schema changed, by names (`StoreHost.applySchema`). */
export interface AppliedSchema {
  readonly schemaHash: string;
  readonly changed: boolean;
  readonly changes: SchemaChanges;
  /** How many records it rewrote: renamed, filled in or migrated. */
  readonly records: number;
  /** When it was applied: what undoing it waits on (`onlyIfAppliedAt`). */
  readonly appliedAt: number;
}

/** The schema a change applies, its hash, indexes and searches planned. */
interface SchemaTarget {
  readonly manifest: SchemaManifest;
  readonly schemaHash: string;
  readonly indexes: Awaited<ReturnType<typeof planIndexes>>;
  readonly searches: Awaited<ReturnType<typeof planSearches>>;
}

/** `input` checked, and what applying it needs worked out first. */
const applyingOf = async (
  input: SchemaApply
): Promise<{
  change: z.output<typeof schemaApplySchema>;
  target: SchemaTarget;
}> => {
  const change = dataErrors.parse("data.invalid", schemaApplySchema, input);
  const { manifest } = readSchema(change.manifest);
  const schemaHash = await hashOf(manifest);
  const tableIds: Record<string, string> = {};
  for (const name of Object.keys(manifest.tables)) {
    const ids = Object.hasOwn(change.ids, name) ? change.ids[name] : undefined;
    if (ids === undefined || !stableIdPattern.test(ids.id)) {
      throw dataErrors.create("data.invalid_schema", {
        issues: [`The table \`${name}\` has no ID in the App's definition`],
      });
    }
    tableIds[name] = ids.id;
  }
  const indexes = await planIndexes(manifest, tableIds);
  const searches = await planSearches(manifest, tableIds);
  return { change, target: { manifest, schemaHash, indexes, searches } };
};

/**
 * A table as the store holds it, for a migration of it: its fields'
 * stored names by stable ID, and who sees each of its records now, by
 * those names (store-rules.ts, `audienceOf`).
 */
export interface HeldTable {
  readonly names: Readonly<Record<string, string>>;
  readonly audience: Audience;
}

/** What starting a migration answers (`StoreHost.beginMigration`). */
export interface MigrationStart {
  readonly migrationId: string;
  /** The schema in force, which its migrations must transform from. */
  readonly schemaHash: string | null;
  /** Each table the store holds, by stable ID. */
  readonly tables: Readonly<Record<string, HeldTable>>;
}

/** A reset of the store's data (`StoreHost.resetData`). */
export interface StoreReset {
  readonly actor: AuditActor;
  /** The App the store serves. */
  readonly app: string;
  /**
   * Whether a store that holds a working schema may be reset: an admin's
   * full reset. Without it only a store from before stable IDs is
   * (`migration.metadata_missing`), as a builder resets it.
   */
  readonly everything: boolean;
  /** The App's current version's schema, applied to the empty store. */
  readonly apply?: SchemaApply;
}

/** A schema change's plan, by names only: what its audit entry records. */
export type SchemaChanges = Pick<
  SchemaChangePlan,
  | "addedTables"
  | "renamedTables"
  | "keptTables"
  | "addedFields"
  | "widenedFields"
  | "keptFields"
  | "accessChanges"
> & {
  readonly renamedFields: readonly {
    readonly table: string;
    readonly from: string;
    readonly to: string;
  }[];
  readonly filledFields: readonly { readonly table: string; field: string }[];
  /** The tables a migration rewrote, by name. */
  readonly migratedTables: readonly string[];
};

/** `plan`, with the tables migrated, by names only (`SchemaChanges`). */
const summaryOf = (
  plan: SchemaChangePlan,
  migrated: ReadonlySet<string>
): SchemaChanges => ({
  addedTables: plan.addedTables,
  renamedTables: plan.renamedTables,
  keptTables: plan.keptTables,
  addedFields: plan.addedFields,
  renamedFields: plan.renamedFields.map(({ table, from, to }) => ({
    table,
    from,
    to,
  })),
  widenedFields: plan.widenedFields,
  filledFields: plan.fills.map(({ table, field }) => ({ table, field })),
  keptFields: plan.keptFields,
  accessChanges: plan.accessChanges,
  migratedTables: [...migrated],
});

/**
 * How long a schema another publish applied may stand without its version
 * made current before a publish over the version current goes over it:
 * far longer than the step from applying a schema to making its version
 * current takes, so only a publish that stopped between them is gone over.
 */
const publishSettleMs = 60_000;

/** Records a schema change rewrites per page, inside its one transaction. */
const rewritePage = 500;

/** Records a page of a migration's rows holds, at most (`migrationRows`). */
const migrationPage = 100;

/**
 * How many characters of fields a page of a migration's rows holds, about:
 * at three bytes a character, still within the 2 MiB one call into the
 * sandbox takes (migration-run.ts).
 */
const migrationPageChars = 512 * 1024;

/** A record a migration reads (`StoreHost.migrationRows`). */
export interface MigrationRow {
  readonly id: string;
  readonly owner: string;
  readonly revision: number;
  readonly fields: StoreFields;
}

/** One batch of a migration's output, as core stages it. */
const migrationBatchSchema = z.strictObject({
  migrationId: z.uuid(),
  /** The table's ID. */
  table: z.string().min(1).max(64),
  rows: z
    .array(
      z.strictObject({
        id: recordIdSchema,
        revision: z.int().min(1),
        fields: storedFieldsSchema,
      })
    )
    .min(1)
    .max(migrationPage),
});
export type MigrationBatch = z.input<typeof migrationBatchSchema>;

/**
 * A store's catalog as its row holds it (schema-changes.ts, `Catalog`):
 * the host wrote it from a schema it read and checked, so each type is a
 * descriptor that was.
 */
const catalogSchema = z.record(
  z.string(),
  z.strictObject({
    name: z.string(),
    kept: z.literal(true).optional(),
    fields: z.record(
      z.string(),
      z.strictObject({
        name: z.string(),
        type: z.custom<ValueDescriptor>((value) => isRecord(value)),
        kept: z.literal(true).optional(),
      })
    ),
  })
);

/** The schema in force, as `StoreHost.#held` keeps it read. */
interface HeldNow extends HeldSchema {
  readonly hash: string;
  /** The catalog's text, as its row holds it. */
  readonly text: string;
  /** Every field each table's records may hold, kept ones included, by name. */
  readonly fields: ReadonlyMap<
    string,
    Readonly<Record<string, ValueDescriptor>>
  >;
}

/** `fields` with each of `renames` under its new name. */
const renamedFields = (
  fields: StoreFields,
  renames: readonly PlannedRename[]
): StoreFields => {
  if (renames.length === 0) {
    return fields;
  }
  const names = new Map(renames.map(({ from, to }) => [from, to]));
  return Object.fromEntries(
    Object.entries(fields).map(([name, value]) => [
      names.get(name) ?? name,
      value,
    ])
  );
};

/** A record a schema change rewrites: as stored, and as its migration staged it. */
interface RewrittenRecord {
  readonly id: string;
  readonly table: string;
  readonly stored: StoreFields;
  /** Its migration's output, at the revision it holds; null for none. */
  readonly staged: StoreFields | null;
}

/** Field `name` of `fields` as canonical text; undefined when absent. */
const fieldText = (fields: StoreFields, name: string): string | undefined =>
  Object.hasOwn(fields, name) ? canonicalJson(fields[name] ?? null) : undefined;

/**
 * A migrated record as the store keeps it: its migration's output, without
 * the old name of any field renamed in the same change. Refused
 * (`migration.failed`) when its record changed since its migration read
 * it, or was added since (`migration.busy`), and when the output changes
 * a field that holds a record ID or a file, before or after
 * (`reference_changed`: the store's reference and file indexes follow
 * only writes it checks, so neither the value nor the type of such a
 * field moves, references following renamed tables aside), or one a row
 * rule reads (`rule_changed`: who sees a record changes only through
 * writes), each field found by its stable ID across a rename.
 */
const migratedFields = (
  record: RewrittenRecord,
  {
    was,
    now,
    rules,
    tableNames,
  }: {
    was: CatalogTable | undefined;
    now: CatalogTable;
    rules: ReadonlySet<string>;
    tableNames: ReadonlyMap<string, string>;
  }
): StoreFields => {
  if (record.staged === null) {
    throw migrationErrors.create("migration.busy");
  }
  const declared = Object.entries(now.fields).flatMap(([id, field]) => {
    const held =
      was !== undefined && Object.hasOwn(was.fields, id)
        ? was.fields[id]
        : undefined;
    return field.kept === true
      ? []
      : [{ field, old: held?.name ?? field.name, oldType: held?.type }];
  });
  const renamedFrom = new Set(
    declared.flatMap(({ field, old }) => (old === field.name ? [] : [old]))
  );
  const fields = Object.fromEntries(
    Object.entries(record.staged).filter(([name]) => !renamedFrom.has(name))
  );
  for (const { field, old, oldType } of declared) {
    const referring =
      holdsReference(field.type) ||
      (oldType !== undefined && holdsReference(oldType));
    const retyped =
      referring &&
      oldType !== undefined &&
      canonicalText(referencesRenamed(oldType, tableNames)) !==
        canonicalText(field.type);
    const reason = referring
      ? "reference_changed"
      : rules.has(field.name) && "rule_changed";
    if (
      reason !== false &&
      (retyped ||
        fieldText(record.stored, old) !== fieldText(fields, field.name))
    ) {
      throw migrationErrors.create("migration.failed", {
        table: record.table,
        id: record.id,
        reason,
        issues: [
          `${field.name}: A migration doesn't change a field that refers to records or that a row rule reads`,
        ],
      });
    }
  }
  return fields;
};

/**
 * The tables of `plan` with a field referring to records whose type
 * changed (its `onDelete`, say), references following renamed tables:
 * whether their records cascade is the new type's to say.
 */
const cascadesChanged = (
  held: HeldSchema | undefined,
  plan: SchemaChangePlan
): string[] => {
  const tableNames = new Map(
    plan.renamedTables.map(({ from, to }) => [from, to])
  );
  return Object.entries(plan.catalog).flatMap(([tableId, table]) => {
    const was =
      held !== undefined && Object.hasOwn(held.catalog, tableId)
        ? held.catalog[tableId]
        : undefined;
    const changed = Object.entries(table.fields).some(([id, field]) => {
      const before =
        was !== undefined && Object.hasOwn(was.fields, id)
          ? was.fields[id]
          : undefined;
      return (
        before !== undefined &&
        holdsReference(field.type) &&
        canonicalText(referencesRenamed(before.type, tableNames)) !==
          canonicalText(field.type)
      );
    });
    return changed ? [tableId] : [];
  });
};

/** Whether `fields` lacks `fill`'s field, or holds null where it can't. */
const lacks = (
  fields: StoreFields,
  { field, absent, nulls }: PlannedFill
): boolean =>
  Object.hasOwn(fields, field) ? nulls && fields[field] === null : absent;

/** A receipt's seed: 32 bytes, as hex. */
const seedPattern = /^[0-9a-f]{64}$/u;

export class StoreHost {
  readonly ctx: DurableObjectState;
  readonly env: Env;
  readonly #db: DrizzleSqliteDODatabase;
  /**
   * Told, by name, the tables whose generation moved on and the
   * generation each is at now, once the write that moved them is over
   * (data-store.ts tells its live queries): a commit's, a migration
   * change's alike. Unset, nobody is told.
   */
  onTablesMoved: ((tables: Record<string, number>) => void) | undefined;
  /** Tables moved since `onTablesMoved` was last told, by ID. */
  readonly #movedIds = new Set<string>();
  /** Each schema read so far, by hash (`#pinned`). */
  readonly #schemas = new Map<string, PinnedSchema>();
  /** The schema in force as last read (`#held`). */
  #heldNow: HeldNow | undefined;
  /** The store's files (file-host.ts). */
  readonly files: FileHost;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.#db = drizzle(ctx.storage);
    this.files = new FileHost(ctx.storage, env, this.#db, {
      bind: (storeId) => {
        this.#bind(storeId, false);
      },
      readable: async (reader, holders) =>
        await this.#readableHolder(reader, holders),
    });
  }

  /**
   * Whether `reader` may read any of `holders`, records holding a file,
   * now: under the schema their App reads with, as a commit decides a
   * record may be referred to (`#referable`).
   */
  async #readableHolder(
    reader: FileReader,
    holders: readonly FileHolder[]
  ): Promise<boolean> {
    const pinned = await this.#pinned(this.#storeId(), reader.schemaHash);
    const none: ReadonlyMap<string, Staged> = new Map();
    return holders.some(({ tableId, recordId }) =>
      this.#referable(pinned, none, reader.principal, reader.roles, {
        table: this.#tableName(tableId),
        tableId,
        recordId,
      })
    );
  }

  /**
   * Applies a version's schema to the store, all of it in one transaction
   * or nothing: the change from what the store holds, diffed by the stable
   * IDs of the App's definition (schema-changes.ts says what applies on
   * its own), its tables renamed and created, its records rewritten where
   * fields were renamed or filled in, each migrated table's records
   * replaced by the output its migration staged (`stageMigration`), the
   * indexes made exactly the schema's, and the schema, its catalog and
   * its version recorded. The manifest is untrusted: it is read as
   * `readSchemaManifest` reads it, bounded and strict, and its hash is
   * computed here, never taken from the caller.
   *
   * Refused, with nothing written: a change that needs a migration, or a
   * field records lack with no value for it (`migration.required`, each
   * listed); a migration staged from another schema than the one in force
   * (`migration.invalid`); a record changed since its migration read it,
   * or another version's schema applied meanwhile (`migration.busy`,
   * retryable). With `version`, only over the version the publish was
   * based on, or the version itself again; one another publish applied
   * that never settled within `publishSettleMs` is gone over.
   */
  async applySchema(
    storeId: StoreId,
    input: SchemaApply
  ): Promise<AppliedSchema> {
    const { change, target } = await applyingOf(input);
    const applied = this.ctx.storage.transactionSync(() =>
      this.#applyIn(storeId, change, target)
    );
    // Only once it committed: a refused change leaves every pinned
    // schema as it was.
    this.#schemas.clear();
    this.#tellMoved();
    return applied;
  }

  /** `applySchema`'s transaction. */
  #applyIn(
    storeId: StoreId,
    change: z.output<typeof schemaApplySchema>,
    target: SchemaTarget
  ): AppliedSchema {
    const { manifest, schemaHash } = target;
    this.#bind(storeId);
    const { version } = change;
    const now = this.#requireApplicable(change);
    const held = this.#held();
    const { migration } = change;
    if (migration !== undefined && migration.from !== held?.hash) {
      throw migrationErrors.create("migration.invalid", {
        reason: "Its migrations transform from a schema the store doesn't hold",
      });
    }
    const migrated = new Set(migration?.tables);
    const plan = planSchemaChange(
      held ?? null,
      { manifest, ids: change.ids },
      { answers: change.answers, migrated }
    );
    if (plan.refused.length > 0) {
      throw migrationErrors.create("migration.required", {
        refused: plan.refused
          .slice(0, refusalsListed)
          .map((refusal) => ({ ...refusal })),
      });
    }
    const recorded = {
      schemaVersion: version?.number ?? null,
      schemaAppliedAt: now,
    };
    if (
      held?.hash === schemaHash &&
      canonicalText(plan.catalog) === held.text
    ) {
      this.#db.update(store).set(recorded).run();
      return {
        schemaHash,
        changed: false,
        changes: summaryOf(plan, new Set()),
        records: 0,
        appliedAt: now,
      };
    }
    // The indexes the schema no longer declares go before any record is
    // rewritten, so no trigger or index of theirs runs for it; the
    // schema's own are built after, over the records as they end up.
    dropIndexes(this.ctx.storage.sql, target.indexes);
    dropSearches(this.ctx.storage.sql, target.searches);
    const moved = this.#tablesOf(plan);
    for (const [tableId, renames] of Map.groupBy(
      plan.renamedFields,
      (rename) => rename.tableId
    )) {
      renameHistoryFields(
        this.#db,
        tableId,
        new Map(renames.map(({ from, to }) => [from, to]))
      );
    }
    const recascaded = cascadesChanged(held, plan);
    const { rewritten, filled } = this.#rewriteRecords(plan, {
      held,
      manifest,
      migration,
      schemaHash,
    });
    const lacking = plan.checks.flatMap((check) =>
      check.answer === null ? this.#lacking(plan, check) : []
    );
    if (lacking.length > 0) {
      throw migrationErrors.create("migration.required", {
        refused: [],
        lacking,
      });
    }
    for (const tableId of recascaded) {
      this.#recascade(tableId, plan.catalog[tableId]);
    }
    if (version !== undefined) {
      this.#auditChange(change.actor, version, plan, {
        rewritten,
        filled,
        migrated,
      });
    }
    this.#markSensitive(manifest);
    installIndexes(this.ctx.storage.sql, target.indexes);
    installSearches(this.ctx.storage.sql, target.searches);
    this.#db
      .update(store)
      .set({
        contractHash: schemaHash,
        contractManifest: manifestText(manifest),
        schemaCatalog: canonicalText(plan.catalog),
        ...recorded,
      })
      .run();
    if (migration !== undefined) {
      this.#db
        .delete(migrationRows)
        .where(eq(migrationRows.migrationId, migration.id))
        .run();
    }
    // Every table moves on, not only those rewritten: a change of access
    // or row rules, a field left out or widened, changes what a read
    // answers too, and every live query reads again.
    this.#rewrote(new Set([...moved, ...Object.keys(plan.catalog)]));
    return {
      schemaHash,
      changed: true,
      changes: summaryOf(plan, migrated),
      records: [...rewritten.values()].reduce((sum, taken) => sum + taken, 0),
      appliedAt: now,
    };
  }

  /**
   * Sets again whether each reference of table `tableId`'s records
   * cascades, as `table` (its catalog entry after a schema change)
   * declares its fields: a reference kept by several places cascades
   * only if every one says so, as a commit keeps it (`#indexReferences`).
   * Only what a record already refers to: a schema change never changes
   * a reference's value.
   */
  #recascade(tableId: string, table: CatalogTable | undefined): void {
    if (table === undefined) {
      return;
    }
    const declared = Object.fromEntries(
      Object.values(table.fields).map(({ name, type }) => [name, type])
    );
    const tableIds = new Map(
      this.#tableRows().map((row) => [row.name, row.tableId])
    );
    let after = "";
    for (;;) {
      const rows = this.ctx.storage.sql
        .exec<{ record_id: string; value_json: string }>(
          "SELECT record_id, value_json FROM sdk_records WHERE table_id = ? AND record_id > ? ORDER BY record_id LIMIT ?",
          tableId,
          after,
          rewritePage
        )
        .toArray();
      if (rows.length === 0) {
        return;
      }
      for (const row of rows) {
        after = row.record_id;
        const fields = storedFieldsSchema.parse(JSON.parse(row.value_json));
        const cascades = new Map<
          string,
          { to: string; id: string; cascade: boolean }
        >();
        for (const reference of recordReferences(declared, fields)) {
          for (const { table: name, cascade } of reference.tables) {
            const to = tableIds.get(name);
            if (to !== undefined) {
              const key = keyOf(to, reference.id);
              cascades.set(key, {
                to,
                id: reference.id,
                cascade: (cascades.get(key)?.cascade ?? true) && cascade,
              });
            }
          }
        }
        for (const { to, id, cascade } of cascades.values()) {
          this.#db
            .update(recordRefs)
            .set({ cascade })
            .where(
              and(
                eq(recordRefs.tableId, tableId),
                eq(recordRefs.recordId, row.record_id),
                eq(recordRefs.toTableId, to),
                eq(recordRefs.toRecordId, id)
              )
            )
            .run();
        }
      }
    }
  }

  /**
   * What a version's schema did to the store's records, audited in the
   * transaction that does it, so it is in the audit log exactly when the
   * records hold it: one entry a table or field renamed (`app.data.renamed`),
   * left out and kept (`app.data.kept`), filled in (`app.data.filled`,
   * with how many records took its value) or migrated (`app.data.migrated`,
   * with how many records it rewrote). Names and counts only. A store made
   * for a draft or a test has no version, and isn't audited.
   */
  #auditChange(
    actor: AuditActor,
    version: { readonly app: string; readonly number: number },
    plan: SchemaChangePlan,
    {
      rewritten,
      filled,
      migrated,
    }: {
      rewritten: ReadonlyMap<string, number>;
      filled: ReadonlyMap<PlannedFill, number>;
      migrated: ReadonlySet<string>;
    }
  ): void {
    const keep = (
      action: string,
      detail: Record<string, string | number | null>
    ): void => {
      this.#keepEvent(actor, action, {
        target: { type: "app", id: version.app },
        detail: { ...detail, version: version.number },
      });
    };
    for (const { from, to } of plan.renamedTables) {
      keep("app.data.renamed", { table: to, field: null, from, to });
    }
    for (const { table, from, to } of plan.renamedFields) {
      keep("app.data.renamed", { table, field: to, from, to });
    }
    for (const table of plan.keptTables) {
      keep("app.data.kept", { table, field: null });
    }
    for (const { table, field } of plan.keptFields) {
      keep("app.data.kept", { table, field });
    }
    for (const [fill, taken] of filled) {
      keep("app.data.filled", {
        table: fill.table,
        field: fill.field,
        records: taken,
      });
    }
    for (const [tableId, taken] of rewritten) {
      const table = plan.catalog[tableId];
      if (table !== undefined && migrated.has(table.name)) {
        keep("app.data.migrated", { table: table.name, records: taken });
      }
    }
  }

  /**
   * Refuses `change` where it may not apply, and answers the time it is
   * applied at, later than any apply before it, so one is told from
   * another. A change without a version, to a store that holds one, is
   * refused (`migration.invalid`): an App's store holds the version of
   * what it applied, and only a draft's or a test's never does, so none
   * goes past the base check (`#requireBase`). One that undoes an apply
   * (`onlyIfAppliedAt`) goes only while nothing was applied since: another
   * publish that applied since answers for the store now.
   */
  #requireApplicable({
    version,
    onlyIfAppliedAt,
  }: Pick<
    z.output<typeof schemaApplySchema>,
    "version" | "onlyIfAppliedAt"
  >): number {
    const stored = this.#db
      .select({
        version: store.schemaVersion,
        appliedAt: store.schemaAppliedAt,
      })
      .from(store)
      .get();
    const now = Math.max(Date.now(), (stored?.appliedAt ?? 0) + 1);
    if (version !== undefined) {
      this.#requireBase(version, now);
    } else if (stored?.version !== null && stored?.version !== undefined) {
      throw migrationErrors.create("migration.invalid", {
        reason: "A change of an App's store names the version it applies",
      });
    }
    if (
      onlyIfAppliedAt !== undefined &&
      stored?.appliedAt !== onlyIfAppliedAt
    ) {
      throw migrationErrors.create("migration.busy");
    }
    return now;
  }

  /**
   * Refuses applying `version`'s schema over another version's that a
   * publish applied less than `publishSettleMs` ago (`migration.busy`):
   * a publish over the same base making it current now, of which that
   * one goes on. Over the version the publish was based on, or its own
   * again, it goes on: a publish putting the current version's schema
   * back is based on its own, and of two publishes of one version, core
   * makes one current and the other loses its compare-and-set.
   */
  #requireBase(
    version: {
      readonly number: number | null;
      readonly basedOn: number | null;
    },
    now: number
  ): void {
    const row = this.#db
      .select({
        version: store.schemaVersion,
        appliedAt: store.schemaAppliedAt,
      })
      .from(store)
      .get();
    if (
      row?.version !== null &&
      row?.version !== undefined &&
      row.version !== version.basedOn &&
      row.version !== version.number &&
      now - (row.appliedAt ?? 0) < publishSettleMs
    ) {
      throw migrationErrors.create("migration.busy");
    }
  }

  /**
   * `plan`'s tables in `sdk_tables`, inside `applySchema`'s transaction:
   * each renamed table under its new name, each new one created under its
   * ID. Answers the IDs of the tables renamed.
   */
  #tablesOf(plan: SchemaChangePlan): string[] {
    const now = Date.now();
    for (const [tableId, table] of Object.entries(plan.catalog)) {
      this.#db
        .insert(tables)
        .values({
          tableId,
          name: table.name,
          nameKey: table.name.toLowerCase(),
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: tables.tableId,
          set: { name: table.name, nameKey: table.name.toLowerCase() },
        })
        .run();
    }
    if (Object.keys(plan.catalog).length > storeMaxTables) {
      throw dataErrors.create("data.too_many_tables");
    }
    return plan.renamedTables.map(({ id }) => id);
  }

  /**
   * Rewrites the records `plan` changes, inside `applySchema`'s
   * transaction, a page at a time: a migrated table's each to what its
   * migration staged for it (`migratedFields`), at the revision it was
   * read at (`migration.busy` for one changed since, or added); any other
   * table's with its renamed fields under their new names and its fills
   * where records lack them. Each record keeps its revision and update
   * time, and its history gets nothing: a schema change is no edit, and
   * what it filled in is one audit entry for each field (`#applyIn`).
   * Answers the IDs of the tables rewritten, and how many records each
   * fill gave its value, by fill.
   */
  #rewriteRecords(
    plan: SchemaChangePlan,
    {
      held,
      manifest,
      migration,
      schemaHash,
    }: {
      held: HeldSchema | undefined;
      manifest: SchemaManifest;
      migration: z.output<typeof schemaApplySchema>["migration"];
      schemaHash: string;
    }
  ): { rewritten: Map<string, number>; filled: Map<PlannedFill, number> } {
    // Each table it went through, and how many of its records it changed.
    const rewritten = new Map<string, number>();
    const filled = new Map<PlannedFill, number>();
    const migrated = new Set(migration?.tables);
    for (const [tableId, table] of Object.entries(plan.catalog)) {
      const renames = plan.renamedFields.filter(
        (rename) => rename.tableId === tableId
      );
      const fills = plan.fills.filter((fill) => fill.tableId === tableId);
      const isMigrated = migrated.has(table.name);
      if (
        table.kept === true ||
        (!isMigrated && renames.length === 0 && fills.length === 0)
      ) {
        continue;
      }
      const guarded = {
        was: held?.catalog[tableId],
        now: table,
        rules: new Set(ruleFieldsOf(manifest.tables[table.name]?.rules)),
        tableNames: new Map(
          plan.renamedTables.map(({ from, to }) => [from, to])
        ),
      };
      const rewrite = (record: RewrittenRecord): StoreFields => {
        if (isMigrated) {
          return migratedFields(record, guarded);
        }
        const renamed = renamedFields(record.stored, renames);
        const lacking = fills.filter((fill) => lacks(renamed, fill));
        for (const fill of lacking) {
          filled.set(fill, (filled.get(fill) ?? 0) + 1);
        }
        return lacking.length === 0
          ? renamed
          : {
              ...renamed,
              ...Object.fromEntries(
                lacking.map(({ field, value }) => [field, value])
              ),
            };
      };
      let after = "";
      let changedHere = 0;
      for (;;) {
        const rows = this.ctx.storage.sql
          .exec<{
            record_id: string;
            revision: number;
            value_json: string;
            staged: string | null;
            staged_revision: number | null;
          }>(
            `SELECT r.record_id, r.revision, r.value_json,
                m.value_json AS staged, m.revision AS staged_revision
              FROM sdk_records r LEFT JOIN sdk_migration_rows m
                ON m.migration_id = ? AND m.table_id = r.table_id
                  AND m.record_id = r.record_id
              WHERE r.table_id = ? AND r.record_id > ?
              ORDER BY r.record_id LIMIT ?`,
            migration?.id ?? "",
            tableId,
            after,
            rewritePage
          )
          .toArray();
        if (rows.length === 0) {
          break;
        }
        for (const row of rows) {
          after = row.record_id;
          const record: RewrittenRecord = {
            id: row.record_id,
            table: table.name,
            stored: storedFieldsSchema.parse(JSON.parse(row.value_json)),
            staged:
              row.staged === null || row.staged_revision !== row.revision
                ? null
                : storedFieldsSchema.parse(JSON.parse(row.staged)),
          };
          const next = rewrite(record);
          const valueJson = storedText(next);
          if (valueJson === row.value_json) {
            continue;
          }
          if (encoder.encode(valueJson).byteLength > documentMaxBytes) {
            throw dataErrors.create("data.invalid", {
              table: table.name,
              id: row.record_id,
              issues: [`A record holds at most ${documentMaxBytes} bytes`],
            });
          }
          this.ctx.storage.sql.exec(
            "UPDATE sdk_records SET value_json = ?, schema_hash = ? WHERE table_id = ? AND record_id = ?",
            valueJson,
            schemaHash,
            tableId,
            row.record_id
          );
          changedHere += 1;
        }
        rewritten.set(tableId, changedHere);
      }
    }
    return { rewritten, filled };
  }

  /**
   * The records of `table` (by the schema's name) that lack `field`
   * (`absent`) or hold null in it (`nulls`), as a refused change lists
   * them: how many, never which.
   */
  #lacking(
    plan: SchemaChangePlan,
    { table, field, absent, nulls }: SchemaChangePlan["checks"][number]
  ): { table: string; field: string; records: number }[] {
    const tableId = Object.entries(plan.catalog).find(
      ([, held]) => held.kept !== true && held.name === table
    )?.[0];
    const [row] = this.ctx.storage.sql
      .exec<{ records: number }>(
        "SELECT count(*) AS records FROM sdk_records WHERE table_id = ? AND ((? AND json_type(value_json, ?) IS NULL) OR (? AND json_type(value_json, ?) = 'null'))",
        tableId ?? "",
        absent ? 1 : 0,
        `$."${field}"`,
        nulls ? 1 : 0,
        `$."${field}"`
      )
      .toArray();
    const lacking = row?.records ?? 0;
    return lacking === 0 ? [] : [{ table, field, records: lacking }];
  }

  /**
   * Resets the store's data and applies the App's current version's
   * schema to it (`apply`), all in one transaction, so a schema that
   * can't be applied leaves the data as it was and the App never stands
   * without one. Every record goes with its references, search entries
   * and history, every table, index and staged migration, and the schema
   * with its catalog; every file is deleted (its bytes purged after,
   * file-host.ts), and the mutation receipts and outbox go, so a key sent
   * again can't answer for a record that is gone. People's preferences
   * stay: they aren't records of a schema.
   *
   * Without `everything`, only a store from before stable IDs is reset:
   * one whose schema has no catalog (`migration.metadata_missing`); any
   * other is refused (`migration.reset_refused`). Audited as `actor`'s,
   * in the same transaction: `store.reset` with the records it held, the
   * files it deleted, the outbox entries it dropped and the version applied, and how many records each table held
   * (`app.data.erased`). Answers what applying the schema did, or null
   * without `apply`.
   */
  async resetData(
    storeId: StoreId,
    input: StoreReset
  ): Promise<AppliedSchema | null> {
    const by = auditActorSchema.parse(input.actor);
    const appId = identifierSchema.parse(input.app);
    const applying =
      input.apply === undefined ? undefined : await applyingOf(input.apply);
    // What every watch hears of: each table, gone or back, at its new
    // generation.
    const reset = new Map<string, number>();
    const applied = this.ctx.storage.transactionSync(() => {
      this.#bind(storeId);
      this.#requireResettable(input.everything, applying?.change.version);
      const held = this.ctx.storage.sql
        .exec<{ name: string; records: number; generation: number }>(
          `SELECT t.name AS name, count(r.record_id) AS records,
              t.generation AS generation
            FROM sdk_tables t LEFT JOIN sdk_records r ON r.table_id = t.table_id
            GROUP BY t.table_id ORDER BY t.name`
        )
        .toArray();
      const counted = (query: string): number =>
        this.ctx.storage.sql.exec<{ n: number }>(query).one().n;
      const outboxed = counted("SELECT count(*) AS n FROM sdk_change_outbox");
      const fileCount = counted(
        "SELECT count(*) AS n FROM sdk_files WHERE state != 'deleted'"
      );
      dropIndexes(this.ctx.storage.sql, new Map());
      dropSearches(this.ctx.storage.sql);
      for (const table of resetTables) {
        this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
      }
      // Its files deleted, as their uploader deletes them: tombstones
      // kept, so no key finds them again, their bytes purged after.
      this.ctx.storage.sql.exec(
        `UPDATE sdk_files SET state = 'deleted', deleted_at = ?,
          deleted_how = CASE state WHEN 'uploading' THEN 'cancelled' ELSE 'deleted' END,
          expires_at = NULL
        WHERE state != 'deleted'`,
        Date.now()
      );
      this.#db
        .update(store)
        .set({
          contractHash: null,
          contractManifest: null,
          schemaCatalog: null,
          schemaVersion: null,
          schemaAppliedAt: null,
          historyBytes: 0,
        })
        .run();
      const done =
        applying === undefined
          ? null
          : this.#applyIn(storeId, applying.change, applying.target);
      // Every table past every generation a read saw before, the ones it
      // brings back included, so each read of the old records is stale.
      const generation =
        Math.max(0, ...held.map(({ generation: was }) => was)) + 1;
      this.#db.update(tables).set({ generation }).run();
      for (const { name } of [...held, ...this.#tableRows()]) {
        reset.set(name, generation);
      }
      // In the transaction that resets it: in the audit log exactly when
      // the data is gone.
      this.#keepEvent(by, "store.reset", {
        target: { type: "store", id: storeId },
        detail: {
          app: appId,
          everything: input.everything ? 1 : 0,
          tables: held.length,
          records: held.reduce((sum, { records: taken }) => sum + taken, 0),
          files: fileCount,
          outbox: outboxed,
          version: applying?.change.version?.number ?? null,
        },
      });
      for (const { name, records: taken } of held) {
        this.#keepEvent(by, "app.data.erased", {
          target: { type: "app", id: appId },
          detail: { store: storeId, table: name, records: taken },
        });
      }
      return done;
    });
    this.#schemas.clear();
    this.#movedIds.clear();
    this.#tell(Object.fromEntries(reset));
    return applied;
  }

  /**
   * Refuses a reset of the store's data where it may not go: without
   * `everything`, of a store that can still be read
   * (`migration.reset_refused`); and over another version than `version`,
   * the one it was asked for as current (none, without a schema to apply),
   * as a publish goes only over its base (`#requireBase`): one published
   * meanwhile refuses it.
   */
  #requireResettable(
    everything: boolean,
    version:
      | { readonly number: number; readonly basedOn: number | null }
      | undefined
  ): void {
    const row = this.#db
      .select({
        hash: store.contractHash,
        manifest: store.contractManifest,
        catalog: store.schemaCatalog,
      })
      .from(store)
      .get();
    const unreadable =
      row?.hash !== null &&
      row?.hash !== undefined &&
      (row.manifest === null || row.catalog === null);
    if (!everything && !unreadable) {
      throw migrationErrors.create("migration.reset_refused");
    }
    this.#requireBase(
      { number: version?.number ?? null, basedOn: version?.basedOn ?? null },
      Date.now()
    );
  }

  /**
   * Starts staging a migration's output (`stageMigration`): every row a
   * publish left staged goes, and the migration gets an ID of its own.
   * Answers it, and the hash of the schema in force, which its
   * migrations must transform from.
   */
  beginMigration(storeId: StoreId): MigrationStart {
    return this.ctx.storage.transactionSync(() => {
      this.#bind(storeId);
      this.#db.delete(migrationRows).run();
      const held = this.#held();
      const heldTables: Record<string, HeldTable> = {};
      for (const [tableId, table] of Object.entries(held?.catalog ?? {})) {
        const declared =
          table.kept === true ? undefined : held?.manifest.tables[table.name];
        heldTables[tableId] = {
          names: Object.fromEntries(
            Object.entries(table.fields).map(([id, field]) => [id, field.name])
          ),
          audience:
            declared === undefined
              ? { owner: false, fields: [] }
              : audienceOf(declared),
        };
      }
      return {
        migrationId: crypto.randomUUID(),
        schemaHash: held?.hash ?? null,
        tables: heldTables,
      };
    });
  }

  /**
   * A page of table `tableId`'s records, for its migration: each with its
   * owner, its revision and its fields, in record order after `after`, at
   * most `migrationPage` records and about `migrationPageChars` characters of them.
   */
  migrationRows(
    storeId: StoreId,
    tableId: string,
    after: string | null
  ): MigrationRow[] {
    return this.ctx.storage.transactionSync(() => {
      this.#bind(storeId);
      this.#requireHeldTable(tableId);
      const rows: MigrationRow[] = [];
      let chars = 0;
      for (const row of this.ctx.storage.sql.exec<{
        record_id: string;
        owner_id: string;
        revision: number;
        value_json: string;
      }>(
        "SELECT record_id, owner_id, revision, value_json FROM sdk_records WHERE table_id = ? AND record_id > ? ORDER BY record_id LIMIT ?",
        tableId,
        after ?? "",
        migrationPage
      )) {
        chars += row.value_json.length;
        if (rows.length > 0 && chars > migrationPageChars) {
          break;
        }
        rows.push({
          id: row.record_id,
          owner: row.owner_id,
          revision: row.revision,
          fields: storedFieldsSchema.parse(JSON.parse(row.value_json)),
        });
      }
      return rows;
    });
  }

  /**
   * Stages one batch of migration `migrationId`'s output: each record of
   * table `table` (by its ID) with its fields after its transform, and the
   * revision it was read at. Applied with
   * the schema (`applySchema`), or dropped as the next migration begins.
   */
  stageMigration(storeId: StoreId, batch: MigrationBatch): void {
    const { migrationId, table, rows } = dataErrors.parse(
      "data.invalid",
      migrationBatchSchema,
      batch
    );
    this.ctx.storage.transactionSync(() => {
      this.#bind(storeId);
      this.#requireHeldTable(table);
      for (const row of rows) {
        this.#db
          .insert(migrationRows)
          .values({
            migrationId,
            tableId: table,
            recordId: row.id,
            revision: row.revision,
            valueJson: storedText(row.fields),
          })
          .onConflictDoUpdate({
            target: [
              migrationRows.migrationId,
              migrationRows.tableId,
              migrationRows.recordId,
            ],
            set: {
              revision: row.revision,
              valueJson: storedText(row.fields),
            },
          })
          .run();
      }
    });
  }

  /** Refuses a table the schema in force doesn't hold (`data.unknown_table`). */
  #requireHeldTable(tableId: string): void {
    const table = this.#held()?.catalog[tableId];
    if (table === undefined || table.kept === true) {
      throw dataErrors.create("data.unknown_table", { table: tableId });
    }
  }

  /**
   * The schema in force and its catalog, as the store's row holds them
   * (call it inside a transaction), or undefined before the store's
   * first schema. Read again only when its hash moved on; both were
   * checked as they were applied (`applySchema`).
   */
  #held(): HeldNow | undefined {
    const row = this.#db
      .select({
        hash: store.contractHash,
        manifest: store.contractManifest,
        catalog: store.schemaCatalog,
      })
      .from(store)
      .get();
    if (row?.hash === null || row?.hash === undefined) {
      return undefined;
    }
    if (row.manifest === null || row.catalog === null) {
      throw migrationErrors.create("migration.metadata_missing");
    }
    if (
      this.#heldNow?.hash !== row.hash ||
      this.#heldNow.text !== row.catalog
    ) {
      const catalog = catalogSchema.parse(JSON.parse(row.catalog));
      const fields = new Map<string, Record<string, ValueDescriptor>>();
      for (const table of Object.values(catalog)) {
        if (table.kept !== true) {
          fields.set(
            table.name,
            Object.fromEntries(
              Object.values(table.fields).map(({ name, type }) => [name, type])
            )
          );
        }
      }
      this.#heldNow = {
        hash: row.hash,
        manifest: readSchemaManifest(row.manifest).manifest,
        catalog,
        text: row.catalog,
        fields,
      };
    }
    return this.#heldNow;
  }

  /**
   * The refusal of a caller pinned to a schema the store doesn't hold
   * (`migration.not_current`), naming the version whose schema it holds:
   * after a publish that couldn't finish, the one to publish again.
   */
  #notCurrent(): Error {
    const row = this.#db
      .select({ version: store.schemaVersion })
      .from(store)
      .get();
    return migrationErrors.create("migration.not_current", {
      storeVersion: row?.version ?? null,
    });
  }

  /**
   * Refuses a write under any schema but the one in force
   * (`migration.not_current`). Call it inside the transaction that
   * writes, with nothing awaited between it and the writes.
   */
  #requireCurrent(schemaHash: string): void {
    if (this.#held()?.hash !== schemaHash) {
      throw this.#notCurrent();
    }
  }

  /**
   * Every field `table`'s records may hold, by name, those the schema in
   * force left out included: what references and files are read by.
   * Call it inside a transaction.
   */
  #storedFields(
    table: string
  ): Readonly<Record<string, ValueDescriptor>> | undefined {
    return this.#held()?.fields.get(table);
  }

  /** The store's tables, by name and ID, in a stable order. */
  #tableRows(): { name: string; tableId: string }[] {
    return this.#db
      .select({ name: tables.name, tableId: tables.tableId })
      .from(tables)
      .orderBy(asc(tables.tableId))
      .all();
  }

  /** The record `id` of `table`, or null if the store has none. */
  get(storeId: StoreId, table: string, id: string): StoredRecord | null {
    const name = dataErrors.parse("data.invalid", tableNameSchema, table);
    const recordId = dataErrors.parse("data.invalid", recordIdSchema, id);
    return this.ctx.storage.transactionSync(() => {
      this.#bind(storeId);
      const row = this.#db
        .select()
        .from(records)
        .where(
          and(
            eq(records.tableId, this.#tableId(name)),
            eq(records.recordId, recordId)
          )
        )
        .get();
      return row === undefined ? null : toStored(row);
    });
  }

  /**
   * Answers one read for `scope`, which core resolved for the invocation:
   * a record by ID, or a query (store-queries.ts, whose threat model this
   * follows), checked against the schema `scope` is pinned to as this
   * store recorded it. The request is untrusted and checked whole.
   */
  async read(
    storeId: StoreId,
    scope: ReadScope,
    request: ReadRequest,
    staged?: StagedWrites
  ): Promise<ReadResult> {
    const reader = dataErrors.parse("data.invalid", readScopeSchema, scope);
    const read = dataErrors.parse(
      "data.invalid_query",
      readRequestSchema,
      request
    );
    const preview =
      staged === undefined
        ? undefined
        : dataErrors.parse("data.invalid", stagedWritesSchema, staged);
    const pinned = await this.#pinned(storeId, reader.schemaHash);
    if (read.kind === "query" && read.query.terminal.kind === "paginate") {
      return await this.#page(storeId, reader, pinned, read.query, preview);
    }
    const names =
      read.kind === "get"
        ? [read.table]
        : [read.query.table, ...relatedTables(pinned, reader, read.query)];
    return this.#readIn(storeId, pinned, reader, names, preview, (statements) =>
      indexRequired(() =>
        read.kind === "get"
          ? readRecord(statements, pinned, reader, read)
          : runQuery(statements, pinned, reader, read.query)
      )
    );
  }

  /**
   * Runs `read` (of tables `names`, the first the one it queries, the others
   * those its related records belong to) in one transaction, with their
   * generations taken first: what the read depended on, which a reader
   * compares later (store-reader.ts), handed back with its answer and
   * added to a data error it fails with (`details.generations`), since a
   * read that failed after it looked at records (`data.not_unique`,
   * `data.result_limit`, ...) depended on them as much as one that
   * answered.
   *
   * Handed back the same way (`sensitive`, and `details.sensitive` on a
   * failure): how many records the read answered of each table it ran a
   * statement on that the store holds sensitive (`#sensitivity`), for
   * core to audit (store-reader.ts). A table is named by the statement
   * that reads it (`ReadSql.on`), before that statement runs: the one
   * place every read's statements pass, its counts, cursor anchors and
   * search bounds included, so no way a read looks at a table and then
   * fails leaves it out. Named even when it answered none of its records,
   * or failed: a filter on its fields that matched nothing, or a `unique`
   * that found two, still tells something of what they hold. A read that
   * ran no statement (`take(0)`, a refusal) looked at nothing and names
   * none, and neither does a table only a `with` named whose records
   * were never looked up.
   *
   * With `preview` (a mutation's writes, staged and not yet committed),
   * the writes are applied first, as its commit would apply them (the
   * same checks, owner, metadata and staging time), the read sees them,
   * and the transaction is then rolled back: nothing is kept, and the
   * generation handed back is the one from before them.
   */
  #readIn<Answer>(
    storeId: StoreId,
    pinned: PinnedSchema,
    reader: ReadScope,
    names: readonly string[],
    preview: Preview | undefined,
    read: (statements: ReadSql) => Answer
  ): {
    value: Answer;
    generations: Record<string, number>;
    sensitive: Record<string, number>;
  } {
    const run = () => {
      this.#bind(storeId, false);
      const generations = this.#generationsOf(pinned, names);
      let readRecords = false;
      const isSensitive = this.#sensitivity();
      // The sensitive tables a statement read (`ReadSql.on`) and the
      // records it answered of each (`ReadSql.answered`): never every
      // table of `names`, which holds those its `with` names whether or
      // not their records were ever looked up.
      const answered = new Map<string, number>();
      const sensitiveRead = (): Record<string, number> =>
        Object.fromEntries(answered);
      try {
        if (preview !== undefined) {
          const { staged } = this.#apply(
            pinned,
            reader.principal,
            reader,
            preview.writes,
            [],
            undefined,
            true
          );
          // Refused as its commit would be: a record a job is deleting.
          this.#requireNotDeleting(staged);
          this.#flush(
            staged,
            reader.principal,
            reader.schemaHash,
            preview.stagedAt
          );
        }
        // The read's own statements, counted: only once SQLite took one
        // has the read looked at records (a refusal before any, such as
        // `data.access_denied`, depended on none, and carries no
        // generations, so its reader isn't rerun for every commit).
        const storage = this.ctx.storage.sql;
        const counted: ReadSql = {
          on: (table) => ({
            exec: <Row extends Record<string, SqlStorageValue>>(
              query: string,
              ...bindings: unknown[]
            ): SqlStorageCursor<Row> => {
              // Named before it runs: a statement that then fails, or
              // whose answer the read fails on, read the table all the
              // same.
              if (isSensitive(table)) {
                answered.set(table, answered.get(table) ?? 0);
              }
              const cursor = storage.exec<Row>(query, ...bindings);
              readRecords = true;
              return cursor;
            },
          }),
          // Rows only of a table a statement named already (`on`): never
          // a table of its own, so a read that ran no statement on it (a
          // search with no terms answers none without one) names none.
          answered: (table, answeredNow) => {
            const sofar = answered.get(table);
            if (sofar !== undefined) {
              answered.set(table, sofar + answeredNow);
            }
          },
        };
        const value = read(counted);
        return { value, generations, sensitive: sensitiveRead() };
      } catch (error) {
        if (
          readRecords &&
          error instanceof Error &&
          dataErrors.codeOf(error) !== undefined
        ) {
          const details: unknown = Reflect.get(error, "details");
          Reflect.set(error, "details", {
            ...(typeof details === "object" && details !== null ? details : {}),
            generations,
            sensitive: sensitiveRead(),
          });
        }
        throw error;
      }
    };
    if (preview === undefined) {
      return this.ctx.storage.transactionSync(run);
    }
    let answer: ReturnType<typeof run> | undefined;
    // Thrown to end the transaction, so SQLite rolls back everything it
    // did; told apart from any other failure by identity.
    const rollback = new Error("Rolled back after a preview");
    try {
      this.ctx.storage.transactionSync(() => {
        answer = run();
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) {
        throw error;
      }
    }
    if (answer === undefined) {
      throw new Error("A preview's transaction ended without an answer");
    }
    return answer;
  }

  /**
   * Notes that the generations of `tableIds` moved on, and tells
   * `onTablesMoved` once the synchronous transaction that moved them is
   * over (a microtask later). It reads the generations then: a write
   * that rolled back (a preview's, a failed commit's) moved nothing, and
   * a watch is told only of a generation past the one it read
   * (store-watches.ts), so telling of one tells nobody.
   */
  #moved(tableIds: Iterable<string>): void {
    const wasEmpty = this.#movedIds.size === 0;
    for (const id of tableIds) {
      this.#movedIds.add(id);
    }
    if (wasEmpty && this.#movedIds.size > 0) {
      queueMicrotask(() => {
        this.#tellMoved();
      });
    }
  }

  #tellMoved(): void {
    const ids = [...this.#movedIds];
    this.#movedIds.clear();
    if (ids.length === 0) {
      return;
    }
    const moved: Record<string, number> = {};
    for (const { name, generation } of this.#db
      .select({ name: tables.name, generation: tables.generation })
      .from(tables)
      .where(inArray(tables.tableId, ids))
      .all()) {
      moved[name] = Math.max(moved[name] ?? 0, generation);
    }
    this.#tell(moved);
  }

  /** Tells the store's watches that the tables `moved` names moved on. */
  #tell(moved: Record<string, number>): void {
    const listener = this.onTablesMoved;
    if (listener === undefined || Object.keys(moved).length === 0) {
      return;
    }
    try {
      listener(moved);
    } catch (error) {
      log.error("store.tell_failed", errorFields(error));
    }
  }

  /**
   * The current generation of each of `names` (tables of this store):
   * what a reader compares its read set with when its reads are done.
   * A table the store doesn't hold is left out, which no read set matches.
   */
  generations(
    storeId: StoreId,
    names: readonly string[]
  ): Record<string, number> {
    // A person's preferences answer their revision as a table would its
    // generation (`preferencesWatch`); every other name is a table's.
    const people = dataErrors.parse(
      "data.invalid",
      z.array(personIdOf).max(preferencesWatchMax),
      names
        .filter((name) => name.startsWith(preferencesWatchPrefix))
        .map((name) => name.slice(preferencesWatchPrefix.length))
    );
    const parsed = dataErrors.parse(
      "data.invalid",
      z.array(tableNameSchema).max(storeMaxTables),
      names.filter((name) => !name.startsWith(preferencesWatchPrefix))
    );
    return this.ctx.storage.transactionSync(() => {
      this.#bind(storeId, false);
      const rows = this.#db
        .select({ name: tables.name, generation: tables.generation })
        .from(tables)
        .where(inArray(tables.name, parsed))
        .all();
      const answer: Record<string, number> = Object.fromEntries(
        rows.map(({ name, generation }) => [name, generation])
      );
      if (people.length > 0) {
        const revisions = new Map(
          this.#db
            .select({
              personId: preferences.personId,
              revision: preferences.revision,
            })
            .from(preferences)
            .where(inArray(preferences.personId, people))
            .all()
            .map(({ personId, revision }) => [personId, revision])
        );
        for (const person of people) {
          answer[preferencesWatch(person)] = revisions.get(person) ?? 0;
        }
      }
      return answer;
    });
  }

  /**
   * What `personId` chose of their preferences, as written, and its
   * revision (null and 0 for a person who never wrote any), which a live
   * read watches (`preferencesWatch`); with the last write's idempotency
   * key, input hash and answer, for a resend of it. Only core calls it,
   * for the signed-in person (app-preferences.ts): this object never
   * chooses whose. First, in the same transaction, the release's
   * `preferencesText` is planned onto the store's preferences contract
   * and applied (`definePreferences`): a release whose preferences differ
   * from one the contract holds reads nothing
   * (`migration.preference_changed`), so the contract always holds what
   * every release that read or wrote preferences declared, whatever
   * became of the apply its seal made.
   */
  readPreferences(
    storeId: StoreId,
    personId: string,
    preferencesText: string
  ): StoredPreferences {
    const person = dataErrors.parse("data.invalid", personIdOf, personId);
    const declared = declaredPreferences(preferencesText);
    return this.ctx.storage.transactionSync(() => {
      this.#bind(storeId, false);
      this.#planPreferences(declared, true);
      const row = this.#db
        .select()
        .from(preferences)
        .where(eq(preferences.personId, person))
        .get();
      return {
        valueJson: row?.valueJson ?? null,
        revision: row?.revision ?? 0,
        lastKey: row?.lastKey ?? null,
        lastInputHash: row?.lastInputHash ?? null,
        lastAnswerJson: row?.lastAnswerJson ?? null,
      };
    });
  }

  /**
   * Forgets what this store keeps of `personId` alone, as core asks once
   * an admin erased them (GRA-903, core's person-erasure.ts): their
   * preferences (their row, its value and its last write's receipt), and
   * the values of the forms they sent kept in the outbox for the App's
   * webhooks, handed over or not (core queues none of theirs after). A
   * store never set up holds none, and is set up by nothing here. The
   * values the store's change history kept of changes made for them, or
   * by them, and an import of theirs never landed, go too. Answers
   * how many preference rows went (0 or 1).
   */
  forgetPerson(storeId: StoreId, personId: string): { forgotten: number } {
    const id = storeIdSchema.parse(storeId);
    const person = dataErrors.parse("data.invalid", personIdOf, personId);
    if (this.ctx.id.name !== id) {
      throw new Error("This object holds another store");
    }
    return this.ctx.storage.transactionSync(() => {
      const bound = this.#db
        .select({ storeId: store.storeId })
        .from(store)
        .get();
      if (bound === undefined) {
        return { forgotten: 0 };
      }
      if (bound.storeId !== id) {
        throw new Error("This object holds another store");
      }
      const gone = this.#db
        .delete(preferences)
        .where(eq(preferences.personId, person))
        .returning({ personId: preferences.personId })
        .all();
      this.#db
        .update(outbox)
        .set({ intent: formValuesCleared })
        .where(
          and(
            eq(outbox.kind, "app.form_sent"),
            sql`json_extract(${outbox.intent}, '$.data.userId') = ${person}`
          )
        )
        .run();
      // The values of the changes made for them, whoever acted (they, an
      // agent, a workflow run or another App), and of those they made for
      // anyone: what was written may be about them. Who acted and which
      // fields changed stay, the company's record.
      this.#db
        .update(recordChanges)
        .set({ beforeJson: null, afterJson: null, valuesLeftOut: "erased" })
        .where(
          and(
            isNotNull(recordChanges.beforeJson),
            or(
              eq(recordChanges.principal, person),
              sql`json_extract(${recordChanges.actor}, '$.userId') = ${person}`,
              sql`json_extract(${recordChanges.actor}, '$.onBehalfOf') = ${person}`
            )
          )
        )
        .run();
      // An import of theirs staged and never landed: its values go.
      this.#db.delete(importRows).where(eq(importRows.principal, person)).run();
      return { forgotten: gone.length };
    });
  }

  /**
   * Plans `preferencesText` (a version's preferences, a strict object's
   * descriptor as JSON) onto the store's preferences contract
   * (`planPreferenceChange`): refused (`migration.preference_changed`,
   * listing each preference) when it changes one a version sealed on the
   * store declared. With `apply`, the contract takes it, in the same
   * transaction. Core's seal checks first, before the version's tables
   * are touched, and applies only once the release is sealed, so a seal
   * that fails leaves nothing in the contract; sealing it again applies
   * it again, which changes nothing the second time. Answers whether the
   * contract changed (or would).
   */
  definePreferences(
    storeId: StoreId,
    preferencesText: string,
    apply: boolean
  ): { changed: boolean } {
    const declared = declaredPreferences(preferencesText);
    return this.ctx.storage.transactionSync(() => {
      this.#bind(storeId);
      return this.#planPreferences(declared, apply);
    });
  }

  /**
   * Within a transaction: `declared` planned onto the preferences
   * contract, refused (`migration.preference_changed`) when it changes a
   * preference the contract holds; with `apply`, the contract takes it.
   */
  #planPreferences(
    declared: ValueDescriptor,
    apply: boolean
  ): { changed: boolean } {
    const plan = planPreferenceChange(this.#preferencesContract(), declared);
    if (!plan.accepted) {
      throw migrationErrors.create("migration.preference_changed", {
        changes: plan.refused.slice(0, refusalsListed).map((refusal) => ({
          ...refusal,
        })),
      });
    }
    if (apply && plan.changed) {
      this.#db
        .update(store)
        .set({ preferencesContract: canonicalText(plan.contract) })
        .run();
    }
    return { changed: plan.changed };
  }

  /** The store's preferences contract, read back and checked, or null. */
  #preferencesContract(): PreferencesContract | null {
    const text = this.#db
      .select({ contract: store.preferencesContract })
      .from(store)
      .get()?.contract;
    if (text === null || text === undefined) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new TypeError("Not an object");
      }
      return Object.fromEntries(
        Object.entries(parsed).map(([name, descriptor]) => [
          name,
          descriptorFromText(JSON.stringify(descriptor)),
        ])
      );
    } catch {
      throw migrationErrors.create("migration.metadata_corrupt");
    }
  }

  /**
   * Writes `valueJson` as `personId`'s preferences, if their revision is
   * still `expectedRevision`, in one transaction: so of two writes from
   * the same revision, one commits. The first creates revision 1. With
   * `receipt`, a write under the key the last write used answers that
   * write's answer when its input is the same (`replay`: a resend of a
   * write whose answer was lost), and refuses when it isn't
   * (`keyConflict`), whatever the revision now; the new row keeps the
   * key, hash and answer. Each outcome is an answer, not a failure. Tells
   * the live reads of `personId`'s preferences, and only theirs, once the
   * write is over. Core checked the value against the App's preferences;
   * this checks only sizes.
   */
  writePreferences(
    storeId: StoreId,
    personId: string,
    expectedRevision: number,
    valueJson: string,
    receipt?: PreferencesReceipt
  ): PreferencesWritten {
    const person = dataErrors.parse("data.invalid", personIdOf, personId);
    const expected = dataErrors.parse(
      "data.invalid",
      z.int().min(0),
      expectedRevision
    );
    const kept = dataErrors.parse(
      "data.invalid",
      preferencesReceiptSchema.optional(),
      receipt
    );
    if (
      typeof valueJson !== "string" ||
      encoder.encode(valueJson).byteLength > documentMaxBytes ||
      (kept !== undefined &&
        encoder.encode(kept.answerJson).byteLength > documentMaxBytes)
    ) {
      throw dataErrors.create("data.invalid");
    }
    const written = this.ctx.storage.transactionSync((): PreferencesWritten => {
      this.#bind(storeId, false);
      const row = this.#db
        .select()
        .from(preferences)
        .where(eq(preferences.personId, person))
        .get();
      if (kept !== undefined && row?.lastKey === kept.key) {
        return row.lastInputHash === kept.inputHash &&
          row.lastAnswerJson !== null
          ? { replay: row.lastAnswerJson }
          : { keyConflict: true };
      }
      const current = row?.revision ?? 0;
      if (current !== expected) {
        return { conflict: true };
      }
      const revision = current + 1;
      const values = {
        revision,
        valueJson,
        updatedAt: Date.now(),
        lastKey: kept?.key ?? null,
        lastInputHash: kept?.inputHash ?? null,
        lastAnswerJson: kept?.answerJson ?? null,
      };
      this.#db
        .insert(preferences)
        .values({ personId: person, ...values })
        .onConflictDoUpdate({ target: preferences.personId, set: values })
        .run();
      return { revision };
    });
    if ("revision" in written) {
      // Told once the transaction is over, as a table's move is
      // (`#tellMoved`): a watch is told only of a revision past its own.
      queueMicrotask(() => {
        try {
          this.onTablesMoved?.({
            [preferencesWatch(person)]: written.revision,
          });
        } catch (error) {
          log.error("store.tell_failed", errorFields(error));
        }
      });
    }
    return written;
  }

  /** The generations of tables `names` of the pinned schema, now. */
  #generationsOf(
    pinned: PinnedSchema,
    names: readonly string[]
  ): Record<string, number> {
    const byId = new Map<string, string>();
    for (const name of names) {
      const tableId = Object.hasOwn(pinned.tableIds, name)
        ? pinned.tableIds[name]
        : undefined;
      if (tableId !== undefined) {
        byId.set(tableId, name);
      }
    }
    if (byId.size === 0) {
      return {};
    }
    const rows = this.#db
      .select({ tableId: tables.tableId, generation: tables.generation })
      .from(tables)
      .where(inArray(tables.tableId, [...byId.keys()]))
      .all();
    return Object.fromEntries(
      rows.map(({ tableId, generation }) => [
        byId.get(tableId) ?? tableId,
        generation,
      ])
    );
  }

  /**
   * One page of `query` for `reader` (store-cursors.ts has its threat
   * model): its cursor decoded first, against this request's query and
   * generation; the page read in one transaction, under the reader's
   * access whatever the cursor holds; and the next page's cursor, when
   * more follow.
   */
  async #page(
    storeId: StoreId,
    reader: ReadScope,
    pinned: PinnedSchema,
    query: QueryRequest,
    preview: Preview | undefined
  ): Promise<ReadResult> {
    const { terminal } = query;
    if (terminal.kind !== "paginate") {
      throw new Error("Not a page");
    }
    const binding: CursorBinding = {
      table: query.table,
      index: query.index,
      range: query.range,
      filter: query.filter,
      order: query.order,
      search: query.search ?? null,
      schemaHash: reader.schemaHash,
      resourceVersion: reader.consumer.resourceVersion,
    };
    const anchor =
      terminal.cursor === null
        ? null
        : await decodeCursor(binding, terminal.cursor);
    const {
      value: read,
      generations,
      sensitive,
    } = this.#readIn(
      storeId,
      pinned,
      reader,
      [query.table, ...relatedTables(pinned, reader, query)],
      preview,
      (statements) =>
        indexRequired(() => readPage(statements, pinned, reader, query, anchor))
    );
    const value: PageAnswer =
      read.hasMore && read.last !== undefined
        ? {
            items: read.items,
            nextCursor: await encodeCursor(binding, read.last),
            hasMore: true,
          }
        : { items: read.items, nextCursor: null, hasMore: false };
    return { value, generations, sensitive };
  }

  /**
   * SQLite's plan for the statement `request` (a query) would run for
   * `scope`, planned exactly as `read` plans it: for tests, which reach it
   * through this host inside the object, never over RPC.
   */
  async explain(
    storeId: StoreId,
    scope: ReadScope,
    request: QueryRequest
  ): Promise<string> {
    const reader = readScopeSchema.parse(scope);
    const pinned = await this.#pinned(storeId, reader.schemaHash);
    const table = readableTable(pinned, reader, request.table);
    const plan = planQuery(pinned, reader, table, request, {
      documents: true,
    });
    return this.ctx.storage.sql
      .exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${plan.statement}`,
        ...plan.params
      )
      .toArray()
      .map(({ detail }) => detail)
      .join("\n");
  }
  /**
   * SQLite's plan for each statement a page of `request` reads after
   * `anchor`, one per seek, planned as `read` plans them: for tests, in
   * the object, never over RPC.
   */
  async explainPage(
    storeId: StoreId,
    scope: ReadScope,
    request: QueryRequest,
    anchor: Anchor
  ): Promise<string[]> {
    const reader = readScopeSchema.parse(scope);
    const pinned = await this.#pinned(storeId, reader.schemaHash);
    return pagePlans(this.ctx.storage.sql, pinned, reader, request, anchor).map(
      (plan) =>
        this.ctx.storage.sql
          .exec<{ detail: string }>(
            `EXPLAIN QUERY PLAN ${plan.statement}`,
            ...plan.params
          )
          .toArray()
          .map(({ detail }) => detail)
          .join("\n")
    );
  }

  /**
   * The schema in force, for a caller pinned to `schemaHash`, with its
   * tables' IDs and its indexes' physical names, planned once until the
   * next schema applied (`applySchema` forgets them). A store holds one
   * schema, the one its App's current version was published with: a
   * caller pinned to any other is refused (`migration.not_current`), and
   * a write is checked again in its transaction (`#requireCurrent`).
   */
  async #pinned(storeId: StoreId, schemaHash: string): Promise<PinnedSchema> {
    const held = this.ctx.storage.transactionSync(() => {
      this.#bind(storeId, false);
      return this.#held();
    });
    if (held?.hash !== schemaHash) {
      throw this.#notCurrent();
    }
    const known = this.#schemas.get(schemaHash);
    if (known !== undefined) {
      return known;
    }
    const tableIds = Object.fromEntries(
      Object.entries(held.catalog).flatMap(([tableId, table]) =>
        table.kept === true ? [] : [[table.name, tableId]]
      )
    );
    const pinned: PinnedSchema = {
      manifest: held.manifest,
      tableIds,
      indexes: await planIndexes(held.manifest, tableIds),
      searches: await planSearches(held.manifest, tableIds),
    };
    // Kept only while it is still the schema in force: one applied while
    // its indexes were planned is read again.
    if (this.#heldNow !== held) {
      return await this.#pinned(storeId, schemaHash);
    }
    this.#schemas.set(schemaHash, pinned);
    return pinned;
  }

  /**
   * Whether a table's change history keeps field names only: any schema
   * handed to the store declared it sensitive (`sdk_tables.sensitive`,
   * set by `#markSensitive`), whatever schema a writer is pinned to.
   * Call it inside a transaction.
   */
  #sensitivity(): (table: string) => boolean {
    const sensitive = new Set(
      this.#db
        .select({ name: tables.name })
        .from(tables)
        .where(eq(tables.sensitive, true))
        .all()
        .map(({ name }) => name)
    );
    return (table) => sensitive.has(table);
  }

  /**
   * Marks the tables `manifest` declares sensitive as the store's sensitive
   * tables, for good, inside `#defineIn`'s transaction: the values their
   * history kept before are cleared in the same transaction, so a table
   * declared sensitive late keeps none of them.
   */
  #markSensitive(manifest: SchemaManifest): void {
    const declared = Object.keys(manifest.tables).filter((table) =>
      declaredSensitive(manifest, table)
    );
    if (declared.length === 0) {
      return;
    }
    const marked = this.#db
      .update(tables)
      .set({ sensitive: true })
      .where(and(inArray(tables.name, declared), eq(tables.sensitive, false)))
      .returning({ tableId: tables.tableId })
      .all()
      .map(({ tableId }) => tableId);
    if (marked.length === 0) {
      return;
    }
    this.#db
      .update(recordChanges)
      .set({ beforeJson: null, afterJson: null, valuesLeftOut: "sensitive" })
      .where(
        and(
          inArray(recordChanges.tableId, marked),
          isNotNull(recordChanges.beforeJson)
        )
      )
      .run();
  }

  /**
   * Stages one batch of import `importId`'s rows: new records of `table`
   * for `principal`, as core checked them against the table's schema
   * (app-data.ts). Nothing of it is a record until `applyImport` lands
   * every batch at once; rows an import left staged longer than
   * `importStagedMs` go with the store's alarm (`runAlarm`). A batch at a
   * place already staged, or for an import of another person or table,
   * is refused.
   */
  async stageImport(storeId: StoreId, batch: ImportBatch): Promise<void> {
    const { importId, principal, table, from, rows } = dataErrors.parse(
      "data.invalid",
      importBatchSchema,
      batch
    );
    if (from + rows.length > appDataImportLimits.maxRows) {
      throw dataErrors.create("data.invalid", {
        issues: [`An import holds at most ${appDataImportLimits.maxRows} rows`],
      });
    }
    this.ctx.storage.transactionSync(() => {
      this.#bind(storeId, false);
      const now = Date.now();
      const other = this.#db
        .select({ one: sql`1` })
        .from(importRows)
        .where(
          and(
            eq(importRows.importId, importId),
            or(
              sql`${importRows.principal} <> ${principal}`,
              sql`${importRows.tableName} <> ${table}`
            )
          )
        )
        .get();
      if (other !== undefined) {
        throw dataErrors.create("data.invalid", {
          issues: ["That import is another's"],
        });
      }
      for (const [offset, { id, fields }] of rows.entries()) {
        this.#db
          .insert(importRows)
          .values({
            importId,
            position: from + offset,
            principal,
            tableName: table,
            recordId: id,
            valueJson: storedText(fields),
            stagedAt: now,
          })
          .run();
      }
    });
    // Its cleanup, should the import never land.
    await this.schedule();
  }

  /**
   * Retention, as the alarm runs it: the change history past its bounds
   * or its age (`pruneHistory`), and rows an import staged more than
   * `importStagedMs` ago and never landed, a page at a time.
   */
  #sweepRetention(): void {
    const now = Date.now();
    pruneHistory(this.ctx.storage, this.#db, now);
    this.ctx.storage.transactionSync(() => {
      this.#db.run(
        sql`DELETE FROM ${importRows} WHERE rowid IN (SELECT rowid FROM ${importRows} WHERE ${importRows.stagedAt} < ${now - importStagedMs} ORDER BY ${importRows.stagedAt} LIMIT ${purgePage})`
      );
    });
  }

  /**
   * Lands import `importId`: every row core staged (`stageImport`), as
   * new records of `principal`'s, in one transaction, all of them or none.
   * Each is checked as a commit's insert is (`#apply`: the table's write
   * access under the schema `schemaHash`, for the roles core resolved just
   * before; IDs not in use; references to records that exist), gets its
   * defaulted fields, and is recorded in the store's change history as an
   * import by `actor`. Its staged rows go in the same transaction, landed
   * or not. Answers how many records it inserted.
   */
  async applyImport(
    storeId: StoreId,
    landing: ImportApply
  ): Promise<{ inserted: number }> {
    const parsed = dataErrors.parse("data.invalid", importApplySchema, {
      ...landing,
      storeId,
    });
    const pinned = await this.#pinned(storeId, parsed.schemaHash);
    const where = eq(importRows.importId, parsed.importId);
    let inserted: number;
    try {
      inserted = this.#landImport(parsed, pinned);
    } catch (error) {
      // Refused: its staged rows go now, in a transaction of their own.
      this.ctx.storage.transactionSync(() => {
        this.#db.delete(importRows).where(where).run();
      });
      throw error;
    }
    // Its event, kept with the rows it landed, handed to core now as far
    // as it goes; the alarm hands over whatever this doesn't.
    await this.schedule();
    try {
      await this.files.flushEvents();
    } catch (error) {
      log.warn("store.import_event_deferred", errorFields(error));
    }
    return { inserted };
  }

  /** `applyImport`'s transaction: answers how many records it inserted. */
  #landImport(
    {
      storeId,
      importId,
      principal,
      actor,
      roles,
      schemaHash,
      rows,
      audit,
    }: z.output<typeof importApplySchema>,
    pinned: PinnedSchema
  ): number {
    return this.ctx.storage.transactionSync(() => {
      this.#bind(storeId);
      const now = Date.now();
      const where = eq(importRows.importId, importId);
      const staged = this.#db
        .select()
        .from(importRows)
        .where(where)
        .orderBy(asc(importRows.position))
        .all();
      this.#db.delete(importRows).where(where).run();
      if (
        staged.length !== rows ||
        staged.some(
          (row, at) =>
            row.position !== at ||
            row.principal !== principal ||
            row.tableName !== staged[0]?.tableName
        )
      ) {
        throw dataErrors.create("data.invalid", {
          issues: ["The import's rows aren't all staged"],
        });
      }
      this.#requireCurrent(schemaHash);
      const writes = staged.map((row): StoredWrite => ({
        op: "insert",
        table: row.tableName,
        id: row.recordId,
        fields: storedFieldsSchema.parse(JSON.parse(row.valueJson)),
      }));
      const { staged: written } = this.#apply(
        pinned,
        principal,
        roles,
        writes,
        []
      );
      this.#requireNotDeleting(written);
      this.#flush(written, principal, schemaHash, now);
      this.#indexReferences(pinned, written, principal, roles);
      // An import may newly hold no file: none of the App's files
      // resources lets a CSV attach one.
      this.files.index(
        written,
        principal,
        (table) => this.#storedFields(table),
        [],
        () => false
      );
      const counted = this.#db
        .update(store)
        .set({ commits: sql`${store.commits} + 1` })
        .returning({ commits: store.commits })
        .get();
      if (counted === undefined) {
        throw new Error("A bound store has no row");
      }
      const sensitive = this.#sensitivity();
      recordChangesIn(
        this.#db,
        written.map((entry) => changeInputOf(entry, sensitive)),
        { source: "import", actor, principal, commit: counted.commits },
        now
      );
      // In the transaction that lands it: an import is in the audit log
      // exactly when its rows are in the store.
      this.#keepEvent(actor, "app.data.imported", {
        target: { type: "app", id: audit.app },
        detail: {
          table: audit.table,
          version: audit.version,
          rows: written.length,
          importId,
        },
      });
      return written.length;
    });
  }

  /**
   * What the store keeps of each of its tables (`sdk_tables`), by name:
   * whether it is sensitive (its history keeps field names only), and how
   * many records it holds, counted in the same query along the records'
   * index by table (`sdk_records_created`).
   */
  tableFacts(storeId: StoreId): Record<string, TableFacts> {
    return this.ctx.storage.transactionSync(() => {
      this.#bind(storeId, false);
      return Object.fromEntries(
        this.#db
          .select({
            name: tables.name,
            sensitive: tables.sensitive,
            // Qualified by hand: Drizzle names a column alone in a subquery.
            records: sql<number>`(SELECT count(*) FROM sdk_records AS counted WHERE counted.table_id = sdk_tables.table_id)`,
          })
          .from(tables)
          .all()
          .map(({ name, sensitive, records: held }) => [
            name,
            { sensitive, records: held },
          ])
      );
    });
  }

  /**
   * A page of the change history of record `id` of `table`, newest first,
   * before change `before` if given, for `scope` (store-changes.ts): only
   * through a table the schema `scope` is pinned to lets them read
   * (`data.access_denied` otherwise), and of an `owner` table only while
   * the record is theirs, as a read of it would show it; none otherwise.
   */
  async history(
    storeId: StoreId,
    scope: ReadScope,
    table: string,
    id: string,
    before: number | null
  ): Promise<RecordChangePage> {
    const reader = dataErrors.parse("data.invalid", readScopeSchema, scope);
    const name = dataErrors.parse("data.invalid", tableNameSchema, table);
    const recordId = dataErrors.parse("data.invalid", recordIdSchema, id);
    const after = dataErrors.parse(
      "data.invalid",
      z.int().min(1).nullable(),
      before
    );
    const pinned = await this.#pinned(storeId, reader.schemaHash);
    return this.ctx.storage.transactionSync(() => {
      this.#bind(storeId, false);
      const readable = readableTable(pinned, reader, name);
      // A record's history is read by whoever may read the record now:
      // its owner for an `owner` table, whoever its read rules admit to it
      // as it stands for a table with rules (store-rules.ts), and then only
      // the changes whose every state they admit them to
      // (`admittedHistoryOf`). One they may not read, or that is gone,
      // shows none, as one with no history.
      if (readable.ownerScoped || readable.rows !== undefined) {
        const row = this.#db
          .select({ ownerId: records.ownerId, valueJson: records.valueJson })
          .from(records)
          .where(
            and(
              eq(records.tableId, readable.tableId),
              eq(records.recordId, recordId)
            )
          )
          .get();
        const mayRead =
          row !== undefined &&
          (!readable.ownerScoped || row.ownerId === reader.principal) &&
          this.#ruleAdmits(readable.rows, fieldsOf(row), row.ownerId);
        if (!mayRead) {
          return { changes: [], next: null };
        }
        const { rows } = readable;
        if (rows !== undefined) {
          return admittedHistoryOf(
            this.#db,
            readable.tableId,
            recordId,
            after,
            fieldsOf(row),
            admittedOnce(readable.declared, (fields) =>
              this.#ruleAdmits(rows, fields, row.ownerId)
            )
          );
        }
      }
      return historyOf(this.#db, readable.tableId, recordId, after);
    });
  }

  /**
   * Claims a mutation's receipt for a new attempt, before its handler
   * runs: a new receipt, or the fence of the one it has moved on, keeping
   * it at least a retention from now. Answers the outcome instead when
   * the mutation committed already, writing nothing;
   * `submission.key_conflict` when the key was used for other input, and
   * `submission.expired` when its receipt expired. Call it only once the
   * caller is authorized in full.
   */
  async claim(input: ClaimInput): Promise<Claimed> {
    const { storeId, scope, key, inputHash, runId, deadline } =
      dataErrors.parse("data.invalid", claimSchema, input);
    const receiptId = await sha256Hex(
      canonicalJson({ storeId, scope: { ...scope }, key: [...key] })
    );
    // A new receipt's, kept with it: every attempt answers from the same.
    const seed = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const claimed = this.ctx.storage.transactionSync((): Claimed => {
      this.#bind(storeId);
      const now = Date.now();
      const receipt = this.#db
        .select()
        .from(receipts)
        .where(eq(receipts.receiptId, receiptId))
        .get();
      if (receipt === undefined) {
        this.#db
          .insert(receipts)
          .values({
            receiptId,
            scope: canonicalJson({ ...scope }),
            principal: scope.principal,
            runId,
            inputHash,
            fence: 1,
            deadline,
            createdAt: now,
            retainUntil: now + retentionMs,
            seed,
          })
          .run();
        return { held: { receiptId, fence: 1 }, startedAt: now, seed };
      }
      if (receipt.expiredAt !== null) {
        throw submissionErrors.create("submission.expired");
      }
      if (receipt.inputHash !== inputHash) {
        throw submissionErrors.create("submission.key_conflict");
      }
      if (receipt.outcome !== null) {
        return {
          outcome: outcomeOf(receipt.outcome),
          startedAt: receipt.createdAt,
        };
      }
      const fence = receipt.fence + 1;
      // One without a seed of its own (written by a release from before
      // receipts kept one, after a rollback) is given one now, kept for
      // its later attempts.
      const kept = seedPattern.test(receipt.seed) ? receipt.seed : seed;
      this.#db
        .update(receipts)
        .set({
          fence,
          deadline,
          retainUntil: Math.max(receipt.retainUntil, now + retentionMs),
          seed: kept,
        })
        .where(eq(receipts.receiptId, receiptId))
        .run();
      return {
        held: { receiptId, fence },
        startedAt: receipt.createdAt,
        seed: kept,
      };
    });
    await this.schedule();
    return claimed;
  }

  /**
   * Commits a mutation's staged writes in one transaction, with its
   * receipt's outcome (its inserted IDs and what it returned) and its
   * outbox entries, or nothing: the attempt must hold the receipt's
   * current fence (`submission.superseded`) before its deadline
   * (`submission.deadline_passed`); every table it read must still be at
   * the generation it read (`data.reads_changed`); each guard's record
   * must still be at the revision read, and each write's record at its
   * expected revision (a record the commit inserted is at 1), otherwise
   * `data.conflict`. Every write is checked against the access of the
   * schema it is pinned to, for the principal and the roles core resolved
   * just before (`#apply`). An attempt whose mutation another attempt
   * committed meanwhile answers that outcome. Inserted records are owned
   * by the principal, under the IDs core minted. An intent whose kind
   * nothing in `consumers` takes is refused
   * (`submission.intent_unsupported`).
   */
  async commit(input: Commit, consumers: OutboxConsumers): Promise<Committed> {
    const {
      storeId,
      principal,
      actor,
      roles,
      schemaHash,
      receipt: held,
      stagedAt,
      guards,
      readSet,
      writes,
      intents,
      attachable,
      result,
    } = dataErrors.parse("data.invalid", commitSchema, input);
    const pinned = await this.#pinned(storeId, schemaHash);
    const committed = this.ctx.storage.transactionSync((): Committed => {
      this.#bind(storeId);
      const now = Date.now();
      const receipt = this.#db
        .select()
        .from(receipts)
        .where(eq(receipts.receiptId, held.receiptId))
        .get();
      if (receipt === undefined || receipt.principal !== principal.userId) {
        throw dataErrors.create("data.receipt_invalid");
      }
      if (receipt.expiredAt !== null) {
        throw submissionErrors.create("submission.expired");
      }
      if (receipt.outcome !== null) {
        return outcomeOf(receipt.outcome);
      }
      if (receipt.fence !== held.fence) {
        throw submissionErrors.create("submission.superseded");
      }
      // The deadline its attempt claimed with: the fence says this
      // attempt made the last claim.
      if (now >= receipt.deadline) {
        throw submissionErrors.create("submission.deadline_passed");
      }
      if (stagedAt > now + stagedAheadMs) {
        throw dataErrors.create("data.invalid", {
          issues: ["stagedAt: Later than the store's clock allows"],
        });
      }
      if (
        intents.some(({ kind }) => consumerFor(consumers, kind) === undefined)
      ) {
        throw submissionErrors.create("submission.intent_unsupported");
      }
      // Checked again here, with nothing awaited between it and the
      // writes: a schema applied since `#pinned` read it.
      this.#requireCurrent(schemaHash);
      // The explicit guards first: a record the mutation asserted a
      // revision of, now at another, is a conflict for its caller
      // (`data.conflict`), never a stale read set to run again for, which
      // could commit a fallback its rerun reached instead.
      const { staged, inserted, cascadeJob } = this.#apply(
        pinned,
        principal.userId,
        roles,
        writes,
        guards,
        () => {
          const current = this.#generationsOf(pinned, Object.keys(readSet));
          for (const [table, generation] of Object.entries(readSet)) {
            if (current[table] !== generation) {
              throw dataErrors.create("data.reads_changed", { table });
            }
          }
        }
      );
      this.#requireNotDeleting(staged);
      this.#flush(staged, principal.userId, schemaHash, stagedAt);
      this.#indexReferences(pinned, staged, principal.userId, roles);
      const cascadePending =
        cascadeJob === undefined
          ? undefined
          : {
              job: this.#startCascadeJob(cascadeJob, {
                receiptId: held.receiptId,
                principal: principal.userId,
                resourceId: resourceOfScope(receipt.scope),
                runId: receipt.runId,
                actor,
                now,
              }),
              members: cascadeJob.members.size,
            };
      if (cascadePending !== undefined) {
        this.#requireCascadeClosed(cascadePending.job);
      }
      // The files they hold, by the same fields as references.
      // Records already holding a file, as the writer reads them now: the
      // commit's own records written, under the schema it is pinned to.
      const none: ReadonlyMap<string, Staged> = new Map();
      this.files.index(
        staged,
        principal.userId,
        (table) => this.#storedFields(table),
        attachable,
        (holders) =>
          holders.some(({ tableId, recordId }) =>
            this.#referable(pinned, none, principal.userId, roles, {
              table: this.#tableName(tableId),
              tableId,
              recordId,
            })
          )
      );
      const counted = this.#db
        .update(store)
        .set({ commits: sql`${store.commits} + 1` })
        .returning({ commits: store.commits })
        .get();
      if (counted === undefined) {
        throw new Error("A bound store has no row");
      }
      // Every record it changed, in its history, in this transaction: what
      // its writes changed, then what its cascade deleted.
      const sensitive = this.#sensitivity();
      const changed = (cascade: boolean): ChangeInput[] =>
        staged
          .filter(({ cascaded: by }) => (by === true) === cascade)
          .map((entry) => changeInputOf(entry, sensitive));
      recordChangesIn(
        this.#db,
        changed(false),
        {
          source: "commit",
          actor,
          principal: principal.userId,
          commit: counted.commits,
        },
        now
      );
      recordChangesIn(
        this.#db,
        changed(true),
        {
          source: "cascade",
          actor,
          principal: principal.userId,
          commit: counted.commits,
        },
        now
      );
      // Whom a cascade deleted records of, kept with the receipt: the
      // deletion is attributable to this commit's principal.
      const cascaded = staged.flatMap(
        ({ table, recordId, base, cascaded: by }) =>
          by === true && base !== undefined
            ? [{ table, id: recordId, owner: base.ownerId }]
            : []
      );
      const outcome: Committed = {
        inserted,
        commit: counted.commits,
        result,
        ...(cascaded.length === 0 ? {} : { cascaded }),
        ...(cascadePending === undefined ? {} : { cascadePending }),
      };
      this.#db
        .update(receipts)
        .set({
          outcome: JSON.stringify(outcome),
          committedAt: now,
          commit: counted.commits,
          retainUntil: Math.max(receipt.retainUntil, now + retentionMs),
        })
        .where(eq(receipts.receiptId, held.receiptId))
        .run();
      for (const [position, intent] of intents.entries()) {
        this.#db
          .insert(outbox)
          .values({
            // The commit's number makes it unique: a key whose tombstone
            // went can commit again under the same receipt ID, and its
            // entries must not pass for the ones a consumer already took.
            id: `${held.receiptId}:${counted.commits}:${position}`,
            receiptId: held.receiptId,
            position,
            kind: intent.kind,
            intent: JSON.stringify(intent),
            createdAt: now,
            nextAttemptAt: now,
          })
          .run();
      }
      return outcome;
    });
    await this.schedule();
    return committed;
  }

  /**
   * The records `writes` change, as they would be after them, checked
   * against the store as it is (call it inside a transaction): each
   * guard's record still at its revision; each write to a table of the
   * pinned schema that the schema lets `roles` write (`data.write_denied`
   * otherwise; `data.unknown_table` for a table it hasn't); a record an
   * `owner` table's write changes owned by `principal`, as one that
   * doesn't exist and one at another revision are (`data.conflict`, the
   * same for all three, so a write learns nothing of a record it may not
   * change); an insert's ID not in use. What a commit writes, and what a
   * preview applies before its read.
   */
  #apply(
    pinned: PinnedSchema,
    principal: string,
    roles: WriterRoles,
    writes: readonly StoredWrite[],
    guards: readonly { table: string; id: string; expectedRevision: number }[],
    afterGuards?: () => void,
    preview = false
  ): { staged: Staged[]; inserted: string[]; cascadeJob?: CascadePlan } {
    const tableIdOf = (table: string): string => {
      const tableId = Object.hasOwn(pinned.tableIds, table)
        ? pinned.tableIds[table]
        : undefined;
      if (
        tableId === undefined ||
        !Object.hasOwn(pinned.manifest.tables, table)
      ) {
        throw dataErrors.create("data.unknown_table", { table });
      }
      return tableId;
    };
    const caller: RuleCaller = { principal, ...roles };
    /**
     * Whether `roles` may write `table`, whether only their own records,
     * and the conditions its row rules set on a row they write: its read
     * rules and its write rules (its read rules where it declares none
     * for writing), both of which a row must pass before and after.
     */
    const writable = (
      table: string
    ): {
      tableId: string;
      own: boolean;
      rows: readonly (Fragment | undefined)[];
    } => {
      const tableId = tableIdOf(table);
      const declared = pinned.manifest.tables[table];
      const mode = declared?.access.write ?? "none";
      const admitted =
        mode === "owner" ||
        (mode === "appMembers" && (roles.appMember || roles.appBuilder)) ||
        (mode === "appBuilders" && roles.appBuilder);
      if (!admitted) {
        throw dataErrors.create("data.write_denied", { table });
      }
      const rules = declared?.rules;
      return {
        tableId,
        own: mode === "owner",
        rows: [
          ruleSql(rules?.read, caller),
          ruleSql(rules?.write ?? rules?.read, caller),
        ],
      };
    };
    const staged = new Map<string, Staged>();
    const stage = (
      table: string,
      tableId: string,
      recordId: string
    ): Staged => {
      const key = keyOf(tableId, recordId);
      const known = staged.get(key);
      if (known !== undefined) {
        return known;
      }
      const base = this.#db
        .select()
        .from(records)
        .where(
          and(eq(records.tableId, tableId), eq(records.recordId, recordId))
        )
        .get();
      const entry: Staged = {
        table,
        tableId,
        recordId,
        base,
        fields: base === undefined ? null : fieldsOf(base),
      };
      staged.set(key, entry);
      return entry;
    };
    /**
     * The staged record and its fields, if it exists at `expected` (and,
     * with `own`, is the principal's); otherwise a conflict.
     */
    const at = (
      table: string,
      tableId: string,
      recordId: string,
      expected: number,
      own: boolean
    ): { entry: Staged; fields: StoreFields } => {
      const entry = stage(table, tableId, recordId);
      const { fields, base } = entry;
      const revision = base?.revision ?? 1;
      // A record an earlier write of this commit changed is shown to the
      // mutation's staged reads at the revision its commit will give it
      // (one more, once, if its fields differ): a later write may assert
      // that, as well as the revision it was read at before the change.
      const shown =
        base !== undefined &&
        fields !== null &&
        storedText(fields) !== base.valueJson
          ? base.revision + 1
          : revision;
      const owned = base === undefined || base.ownerId === principal;
      if (
        fields === null ||
        (expected !== revision && expected !== shown) ||
        (own && !owned)
      ) {
        throw conflict(table, recordId);
      }
      return { entry, fields };
    };

    for (const guard of guards) {
      at(
        guard.table,
        tableIdOf(guard.table),
        guard.id,
        guard.expectedRevision,
        false
      );
    }
    afterGuards?.();
    const inserted: string[] = [];
    for (const write of writes) {
      const { tableId, own, rows } = writable(write.table);
      /** Whether the table's read and write rules both admit the writer. */
      const admits = (fields: StoreFields, owner: string): boolean =>
        rows.every((condition) => this.#ruleAdmits(condition, fields, owner));
      // A write reaches a row only while the table's read and write rules
      // both admit the writer to it (as Postgres's row security's USING
      // and WITH CHECK), and leaves it only where they still do: a write
      // that would move a row out of their reach (another assignee,
      // another team) is refused whole, and so is one that would make a
      // row they can't read readable. `owner` never moves (the host keeps
      // it), so a rule on it always holds after.
      const keepsInReach = (entry: Staged): void => {
        if (
          entry.fields !== null &&
          !admits(entry.fields, entry.base?.ownerId ?? principal)
        ) {
          throw dataErrors.create("data.write_denied", { table: write.table });
        }
      };
      if (write.op === "insert") {
        const entry = stage(write.table, tableId, write.id);
        if (entry.base !== undefined || entry.fields !== null) {
          throw conflict(write.table, write.id);
        }
        entry.fields = write.fields;
        keepsInReach(entry);
        inserted.push(write.id);
        continue;
      }
      const { entry, fields } = at(
        write.table,
        tableId,
        write.id,
        write.expectedRevision,
        own
      );
      // A row the rules keep from the writer, for reading or writing, is
      // answered as one that isn't there, as `owner` answers another's
      // (`at`): a patch, replacement or deletion learns nothing of it,
      // and can't move it into their sight.
      if (!admits(fields, entry.base?.ownerId ?? principal)) {
        throw conflict(write.table, write.id);
      }
      if (write.op === "delete") {
        entry.fields = null;
      } else if (write.op === "replace") {
        // Fields the schema doesn't declare are kept, their values with
        // them (`applySchema`): a replacement keeps them, as a patch does,
        // and never strips them.
        const declared = pinned.manifest.tables[write.table]?.fields ?? {};
        entry.fields = {
          ...Object.fromEntries(
            Object.entries(fields).filter(
              ([name]) => !Object.hasOwn(declared, name)
            )
          ),
          ...write.fields,
        };
      } else {
        const unset = new Set(write.unset);
        entry.fields = Object.fromEntries(
          Object.entries({ ...fields, ...write.fields }).filter(
            ([name]) => !unset.has(name)
          )
        );
      }
      keepsInReach(entry);
    }
    const cascadeJob = this.#cascade(staged, stage, preview);
    return {
      staged: [...staged.values()],
      inserted,
      ...(cascadeJob === undefined ? {} : { cascadeJob }),
    };
  }

  /**
   * Deletes, with the records `staged` deletes, every record that refers to
   * one of them through fields that all say `onDelete: "cascade"`, and so
   * on from those, as the schema each was written under declared it
   * (`sdk_record_refs`). The policy is the schema's, declared by the App's
   * builders: it deletes a referring record whatever the writer could
   * write, as the record it refers to is gone. A referring record this
   * commit writes itself is left to its write: if it still refers to a
   * deleted record, the commit is refused as restrict refuses it
   * (`#indexReferences`).
   *
   * At most `commitMaxCascade` records in the commit itself. Past that,
   * the commit deletes nothing: its deletions, and everything they reach,
   * are planned as a cascade job instead (`#planCascadeJob`), which the
   * store's alarm deletes after the commit, in batches. Answers the plan,
   * if there is one. A `preview` plans none: past the bound, its
   * deletions are left pending, as its commit leaves them at once.
   */
  #cascade(
    staged: Map<string, Staged>,
    stage: (table: string, tableId: string, recordId: string) => Staged,
    preview: boolean
  ): CascadePlan | undefined {
    const pending = [...staged.values()].filter(
      ({ base, fields }) => base !== undefined && fields === null
    );
    const added: string[] = [];
    let cascaded = 0;
    for (let gone = pending.pop(); gone !== undefined; gone = pending.pop()) {
      // One more than the bound has room for is enough to plan a job: no
      // more is read here. (Records already staged are among them, but
      // are never more than the commit's own writes and what it cascaded.)
      const referring = this.#db
        .select({ tableId: recordRefs.tableId, recordId: recordRefs.recordId })
        .from(recordRefs)
        .where(
          and(
            eq(recordRefs.toTableId, gone.tableId),
            eq(recordRefs.toRecordId, gone.recordId),
            eq(recordRefs.cascade, true)
          )
        )
        .limit(commitMaxCascade - cascaded + staged.size + 1)
        .all();
      for (const { tableId, recordId } of referring) {
        const key = keyOf(tableId, recordId);
        if (staged.has(key)) {
          continue;
        }
        cascaded += 1;
        if (cascaded > commitMaxCascade) {
          // What this commit cascaded so far is the job's now.
          for (const staging of added) {
            staged.delete(staging);
          }
          if (preview) {
            // A preview plans no job: it shows what its commit leaves at
            // once, the deletions pending, their records as they are. A
            // record a job is deleting already is refused, as its commit's
            // plan refuses it (`#planCascadeJob`).
            const deletions = [...staged.values()].filter(
              (entry) => entry.base !== undefined && entry.fields === null
            );
            this.#requireNotDeleting(deletions);
            for (const entry of deletions) {
              if (entry.base !== undefined) {
                entry.fields = fieldsOf(entry.base);
              }
            }
            return undefined;
          }
          return this.#planCascadeJob(staged);
        }
        const entry = stage(this.#tableName(tableId), tableId, recordId);
        entry.fields = null;
        entry.cascaded = true;
        added.push(key);
        pending.push(entry);
      }
    }
    return undefined;
  }

  /**
   * The cascade job of a commit whose deletions reach more than one
   * commit may delete (`#cascade`): those deletions (taken back from the
   * commit, which leaves them where they are), and every record they
   * reach through cascading references, at every level, read in this
   * transaction. Past `cascadeJobMaxRecords` in all, refused
   * (`data.cascade_limit`); a record another job is deleting already,
   * refused too (`data.deleting`). A referring record the commit writes
   * itself is no member: if it still refers to one once written, the
   * commit is refused (`#requireCascadeClosed`). Nothing is written here.
   */
  #planCascadeJob(staged: Map<string, Staged>): CascadePlan {
    const members = new Map<string, CascadeMember>();
    const pending: CascadeMember[] = [];
    const add = (member: CascadeMember): void => {
      const key = keyOf(member.tableId, member.recordId);
      if (members.has(key)) {
        return;
      }
      if (this.#isDeleting(member.tableId, member.recordId)) {
        throw dataErrors.create("data.deleting");
      }
      members.set(key, member);
      if (members.size > cascadeJobMaxRecords) {
        throw dataErrors.create("data.cascade_limit", {
          limit: cascadeJobMaxRecords,
        });
      }
      pending.push(member);
    };
    let root: CascadeMember | undefined;
    for (const entry of staged.values()) {
      if (entry.base !== undefined && entry.fields === null) {
        // Deleted by the job instead, after the commit: the commit leaves
        // the record as it was.
        entry.fields = fieldsOf(entry.base);
        const member = { tableId: entry.tableId, recordId: entry.recordId };
        root ??= member;
        add(member);
      }
    }
    if (root === undefined) {
      throw new Error("A cascade job planned without a deletion");
    }
    for (let gone = pending.pop(); gone !== undefined; gone = pending.pop()) {
      // Every record referring to it, a page at a time in the order of
      // their IDs: records the job has already are skipped, never counted
      // against a page, so none it still needs is missed. Past the bound,
      // `add` refuses at once.
      let after: { tableId: string; recordId: string } | undefined;
      for (;;) {
        const referring = this.#db
          .select({
            tableId: recordRefs.tableId,
            recordId: recordRefs.recordId,
          })
          .from(recordRefs)
          .where(
            and(
              eq(recordRefs.toTableId, gone.tableId),
              eq(recordRefs.toRecordId, gone.recordId),
              eq(recordRefs.cascade, true),
              after === undefined
                ? undefined
                : sql`(${recordRefs.tableId}, ${recordRefs.recordId}) > (${after.tableId}, ${after.recordId})`
            )
          )
          .orderBy(asc(recordRefs.tableId), asc(recordRefs.recordId))
          .limit(cascadePlanPage)
          .all();
        for (const { tableId, recordId } of referring) {
          // Left to the commit's own write (`#requireCascadeClosed`).
          const written = staged.get(keyOf(tableId, recordId));
          if (written !== undefined && written.fields !== null) {
            continue;
          }
          add({ tableId, recordId });
        }
        after = referring.at(-1);
        if (referring.length < cascadePlanPage) {
          break;
        }
      }
    }
    return { root, members };
  }

  /**
   * Refuses (`data.referenced`, naming nothing, as a cascaded restrict is)
   * the cascade job `jobId` if a record outside it refers to any of its
   * members, after the commit's own writes (call it inside the commit's
   * transaction, after `#indexReferences` and `#startCascadeJob`, whose
   * writes the refusal rolls back): a restricting reference, or a
   * cascading one the commit's own write kept. So the job never meets a
   * reference it can't delete, and nothing is deleted at all.
   */
  #requireCascadeClosed(jobId: string): void {
    // The first reference into the job from a record outside it, if any:
    // at most one row read, whatever the job's size.
    const outsider = this.ctx.storage.sql
      .exec(
        `SELECT 1 FROM sdk_cascade_members m
         JOIN sdk_record_refs r
           ON r.to_table_id = m.table_id AND r.to_record_id = m.record_id
         WHERE m.job_id = ?
           AND NOT EXISTS (SELECT 1 FROM sdk_cascade_members o
             WHERE o.job_id = m.job_id
               AND o.table_id = r.table_id AND o.record_id = r.record_id)
         LIMIT 1`,
        jobId
      )
      .toArray();
    if (outsider.length > 0) {
      throw dataErrors.create("data.referenced");
    }
  }

  /**
   * Records `plan` as a cascade job of the commit holding receipt
   * `receiptId` (call it inside the commit's transaction): the job, every
   * member, and its `store.cascade_started` event. Answers the job's ID.
   * The alarm deletes its members after the commit (`#runCascadeJobs`).
   */
  #startCascadeJob(
    plan: CascadePlan,
    { receiptId, principal, resourceId, runId, actor, now }: CascadeStart
  ): string {
    const jobId = crypto.randomUUID();
    this.#db
      .insert(cascadeJobs)
      .values({
        jobId,
        receiptId,
        principal,
        resourceId,
        runId,
        actor: JSON.stringify(actor),
        rootTableId: plan.root.tableId,
        rootRecordId: plan.root.recordId,
        planned: plan.members.size,
        createdAt: now,
      })
      .run();
    for (const { tableId, recordId } of plan.members.values()) {
      this.#db
        .insert(cascadeMembers)
        .values({ tableId, recordId, jobId })
        .run();
    }
    this.#cascadeEvent("store.cascade_started", principal, {
      job: jobId,
      table: this.#tableName(plan.root.tableId),
      id: plan.root.recordId,
      members: plan.members.size,
      app: resourceId,
      run: runId,
    });
    return jobId;
  }

  /**
   * Records a cascade job's audit event, `action` by `principal`, in the
   * transaction the caller runs: handed to core with the store's other
   * events (`FileHost.flushEvents`). Identifiers and counts only.
   */
  #cascadeEvent(
    action: string,
    principal: string,
    detail: Record<string, string | number | null>,
    provenance: readonly string[] = []
  ): void {
    this.#keepEvent({ type: "person", userId: principal }, action, {
      target: { type: "store", id: this.#storeId() },
      detail,
      provenance,
    });
  }

  /**
   * Keeps an audit event, `action` by `actor`, in the transaction the
   * caller runs: handed to core with the store's other events
   * (`FileHost.flushEvents`), so it is recorded exactly when what it
   * records commits. Identifiers and counts only.
   */
  #keepEvent(
    actor: AuditActor,
    action: string,
    {
      target,
      detail,
      provenance = [],
    }: {
      target: { type: string; id: string };
      detail: Record<string, string | number | null>;
      provenance?: readonly string[];
    }
  ): void {
    const now = Date.now();
    const event: AuditEvent = auditEventSchema.parse({
      id: crypto.randomUUID(),
      at: new Date(now).toISOString(),
      source: "core",
      actor,
      action,
      target,
      provenance,
      detail,
    });
    this.#db
      .insert(fileEvents)
      .values({ id: event.id, event: JSON.stringify(event), createdAt: now })
      .run();
  }

  /**
   * The cascade job whose batch is next: unfinished, and not failed (or
   * set aside long enough, `cascadeFailedRetryMs`), the
   * one whose batches failed least first, then the oldest; none of
   * `skipped`. So a job whose batches keep failing goes behind the others,
   * which go on.
   */
  #nextCascadeJob(skipped: ReadonlySet<string>): CascadeJob | undefined {
    return this.#db
      .select()
      .from(cascadeJobs)
      .where(
        and(
          isNull(cascadeJobs.finishedAt),
          or(
            isNull(cascadeJobs.failedAt),
            lte(cascadeJobs.failedAt, Date.now() - cascadeFailedRetryMs)
          ),
          notInArray(cascadeJobs.jobId, [...skipped])
        )
      )
      .orderBy(asc(cascadeJobs.attempts), asc(cascadeJobs.createdAt))
      .limit(1)
      .get();
  }

  /**
   * The next members of `job` to delete, at most `commitMaxCascade`: those
   * no remaining record refers to, so the records referring to a member go
   * before it, the root last, and a reader never meets a reference to a
   * record that's gone. Only their IDs and owners are read.
   *
   * Members that refer to each other in a cycle are never such leaves, and
   * a long chain has one at a time. So when fewer than
   * `cascadeLeavesAtLeast` are found, the batch is filled up with other
   * members, picked at random, and the references other members of the
   * job hold to them are dropped, so they are leaves too: a cycle or chain
   * of any length is cut into many, each ending in a leaf, and goes a
   * batch at a time. Nothing outside the job refers to a member
   * (`#requireCascadeClosed`, and new references to one are refused), so
   * only members still due for deletion can meet a reference to a record
   * that's gone: records already deleting (`data.deleting`), deleted in a
   * later batch.
   */
  #cascadeBatchOf(job: CascadeJob): {
    members: CascadeBatchMember[];
    cut: number;
  } {
    const leaves = this.ctx.storage.sql
      .exec<CascadeBatchMember>(
        `SELECT m.table_id AS tableId, m.record_id AS recordId,
           rec.owner_id AS ownerId
         FROM sdk_cascade_members m
         LEFT JOIN sdk_records rec
           ON rec.table_id = m.table_id AND rec.record_id = m.record_id
         WHERE m.job_id = ? AND NOT ${referredSql}
         LIMIT ?`,
        job.jobId,
        commitMaxCascade
      )
      .toArray();
    if (leaves.length >= cascadeLeavesAtLeast) {
      return { members: leaves, cut: 0 };
    }
    const cut = this.ctx.storage.sql
      .exec<CascadeBatchMember>(
        `SELECT m.table_id AS tableId, m.record_id AS recordId,
           rec.owner_id AS ownerId
         FROM sdk_cascade_members m
         LEFT JOIN sdk_records rec
           ON rec.table_id = m.table_id AND rec.record_id = m.record_id
         WHERE m.job_id = ? AND ${referredSql}
         ORDER BY random()
         LIMIT ?`,
        job.jobId,
        commitMaxCascade - leaves.length
      )
      .toArray();
    for (const { tableId, recordId } of cut) {
      this.ctx.storage.sql.exec(
        `DELETE FROM sdk_record_refs
         WHERE to_table_id = ? AND to_record_id = ?
           AND EXISTS (SELECT 1 FROM sdk_cascade_members o
             WHERE o.job_id = ?
               AND o.table_id = sdk_record_refs.table_id
               AND o.record_id = sdk_record_refs.record_id)`,
        tableId,
        recordId,
        job.jobId
      );
    }
    // The cut first: the batch deletes all of them, whatever its deadline.
    return { members: [...cut, ...leaves], cut: cut.length };
  }

  /**
   * Deletes the next batch of cascade job `job` (`#cascadeBatchOf`), in
   * one transaction, stopping early once `deadline` passes with some of it
   * deleted. Each record goes as a commit's deletion goes (`#flush`, its
   * references, its files), its member row with it; `store.cascade_batch`
   * events name them, per table and owner, at most
   * `auditProvenanceMaxItems` an event. The job finishes with its last
   * member; a batch done clears its failures. A throw changes nothing: the
   * transaction rolls back.
   */
  #deleteCascadeBatch(job: CascadeJob, deadline: number): void {
    this.ctx.storage.transactionSync((): void => {
      const deleted: Staged[] = [];
      const batch = this.#cascadeBatchOf(job);
      for (const [
        at,
        { tableId, recordId, ownerId },
      ] of batch.members.entries()) {
        // Never before the cut members are gone: what refers to them no
        // longer says so in the index (`#cascadeBatchOf`).
        if (at >= batch.cut && deleted.length > 0 && Date.now() >= deadline) {
          break;
        }
        if (ownerId !== null) {
          deleted.push({
            table: this.#tableName(tableId),
            tableId,
            recordId,
            // A deletion reads no more of the record than that it is there
            // and whose it is: its document is never loaded.
            base: deletedBase(tableId, recordId, ownerId),
            fields: null,
            cascaded: true,
          });
        }
        this.#db
          .delete(cascadeMembers)
          .where(
            and(
              eq(cascadeMembers.tableId, tableId),
              eq(cascadeMembers.recordId, recordId)
            )
          )
          .run();
      }
      // As a commit's deletion: the records, their tables' generations
      // and the live queries told; their references; their files.
      this.#flush(deleted, job.principal, "", Date.now());
      for (const { tableId, recordId } of deleted) {
        this.#db
          .delete(recordRefs)
          .where(
            and(
              eq(recordRefs.tableId, tableId),
              eq(recordRefs.recordId, recordId)
            )
          )
          .run();
      }
      this.files.index(
        deleted,
        job.principal,
        (table) => this.#storedFields(table),
        [],
        () => false
      );
      this.#cascadeBatchEvents(job, deleted);
      // In the history too, as the commit's actor's: a deletion that never
      // read the record's fields keeps none of them.
      recordChangesIn(
        this.#db,
        deleted.map(({ tableId, table, recordId }): ChangeInput => ({
          tableId,
          tableName: table,
          recordId,
          before: {},
          after: null,
          unread: true,
          sensitive: false,
        })),
        {
          source: "cascade",
          actor: auditActorSchema.parse(JSON.parse(job.actor)),
          principal: job.principal,
          commit: null,
        },
        Date.now()
      );
      const done = job.deleted + deleted.length;
      const left = this.#db
        .select({ one: sql`1` })
        .from(cascadeMembers)
        .where(eq(cascadeMembers.jobId, job.jobId))
        .get();
      this.#db
        .update(cascadeJobs)
        .set({
          deleted: done,
          attempts: 0,
          failedAt: null,
          ...(left === undefined ? { finishedAt: Date.now() } : {}),
        })
        .where(eq(cascadeJobs.jobId, job.jobId))
        .run();
      if (left === undefined) {
        this.#cascadeEvent("store.cascade_finished", job.principal, {
          job: job.jobId,
          deleted: done,
          app: job.resourceId,
          run: job.runId,
        });
      }
    });
  }

  /**
   * The `store.cascade_batch` events of `deleted`, a batch of `job`: one
   * per table and owner, each naming at most `auditProvenanceMaxItems`
   * records.
   */
  #cascadeBatchEvents(job: CascadeJob, deleted: readonly Staged[]): void {
    const groups = new Map<
      string,
      { table: string; owner: string; ids: string[] }
    >();
    for (const { table, recordId, base } of deleted) {
      const owner = base?.ownerId ?? "";
      const key = `${table}\u0000${owner}`;
      const group = groups.get(key) ?? { table, owner, ids: [] };
      group.ids.push(recordId);
      groups.set(key, group);
    }
    for (const { table, owner, ids } of groups.values()) {
      for (let at = 0; at < ids.length; at += auditProvenanceMaxItems) {
        const named = ids.slice(at, at + auditProvenanceMaxItems);
        this.#cascadeEvent(
          "store.cascade_batch",
          job.principal,
          {
            job: job.jobId,
            table,
            owner,
            count: named.length,
            app: job.resourceId,
            run: job.runId,
          },
          named
        );
      }
    }
  }

  /**
   * Counts a failed batch of `job`, in a transaction of its own (the
   * batch's rolled back). Its `cascadeJobMaxAttempts`th in a row fails the
   * job, audited (`store.cascade_failed`, with how far it got): set aside,
   * its records still deleting, and tried again `cascadeFailedRetryMs`
   * later. Its members are never released: references among them may have
   * been cut (`#cascadeBatchOf`), and records written again would then
   * disagree with the index.
   */
  #cascadeFailed(job: CascadeJob): void {
    this.ctx.storage.transactionSync(() => {
      const attempts = job.attempts + 1;
      const failing = attempts >= cascadeJobMaxAttempts;
      this.#db
        .update(cascadeJobs)
        .set({ attempts, ...(failing ? { failedAt: Date.now() } : {}) })
        .where(eq(cascadeJobs.jobId, job.jobId))
        .run();
      if (!failing) {
        return;
      }
      const left = this.#db
        .select({ count: count() })
        .from(cascadeMembers)
        .where(eq(cascadeMembers.jobId, job.jobId))
        .get();
      this.#cascadeEvent("store.cascade_failed", job.principal, {
        job: job.jobId,
        table: this.#tableName(job.rootTableId),
        id: job.rootRecordId,
        deleted: job.deleted,
        left: left?.count ?? 0,
        app: job.resourceId,
        run: job.runId,
      });
    });
  }

  /**
   * The alarm's turn at the store's cascade jobs: batch after batch
   * (`#deleteCascadeBatch`), each its own transaction, until none is left,
   * `cascadeBatchesPerAlarm` are done or `cascadeBudgetMs` is spent; the
   * next alarm, due at once (`schedule`), goes on from there. A batch that
   * fails is counted against its job (`#cascadeFailed`), which this alarm
   * then leaves: the next batch is another job's, if there is one.
   */
  #runCascadeJobs(): void {
    const deadline = Date.now() + cascadeBudgetMs;
    const failed = new Set<string>();
    for (
      let batches = 0;
      batches < cascadeBatchesPerAlarm && Date.now() < deadline;
      batches += 1
    ) {
      const job = this.#nextCascadeJob(failed);
      if (job === undefined) {
        return;
      }
      try {
        this.#deleteCascadeBatch(job, deadline);
      } catch (error) {
        log.error("store.cascade_batch_failed", {
          job: job.jobId,
          ...errorFields(error),
        });
        this.#cascadeFailed(job);
        failed.add(job.jobId);
      }
    }
  }

  /**
   * Refuses (`data.deleting`) a commit that changes or deletes a record a
   * cascade job is deleting: it is left as it is until the job deletes it.
   */
  #requireNotDeleting(staged: readonly Staged[]): void {
    for (const { tableId, recordId, base, fields } of staged) {
      const changes =
        base !== undefined &&
        (fields === null || storedText(fields) !== base.valueJson);
      if (changes && this.#isDeleting(tableId, recordId)) {
        throw dataErrors.create("data.deleting");
      }
    }
  }

  /** Whether a cascade job is deleting record `recordId` of `tableId`. */
  #isDeleting(tableId: string, recordId: string): boolean {
    return (
      this.#db
        .select({ jobId: cascadeMembers.jobId })
        .from(cascadeMembers)
        .where(
          and(
            eq(cascadeMembers.tableId, tableId),
            eq(cascadeMembers.recordId, recordId)
          )
        )
        .get() !== undefined
    );
  }

  /** The name of the store's table `tableId`, for what a refusal says. */
  #tableName(tableId: string): string {
    return (
      this.#db
        .select({ name: tables.name })
        .from(tables)
        .where(eq(tables.tableId, tableId))
        .get()?.name ?? tableId
    );
  }

  /**
   * Keeps the references the records a commit changed make
   * (`sdk_record_refs`), as its schema declares them (store-references.ts),
   * then refuses (`data.referenced`) the commit if a record it deleted is
   * still referred to by a record it didn't (restrict): call it inside the
   * commit's transaction, after its writes, so the refusal undoes them all.
   * A record referring to itself, or to another this commit deletes too,
   * doesn't keep it.
   *
   * A reference a record didn't hold before must name a record that
   * exists, after this commit, and that `principal` with `roles` may read
   * under the pinned schema (`#referable`); otherwise the commit is
   * refused (`data.reference_invalid`, the same whether the record is
   * missing or unreadable, so it learns nothing of others' records). So
   * nobody can keep a record they may not see from being deleted by
   * referring to it. A reference the record already held is kept as it
   * is, whoever may read its record now.
   *
   * A record's references are read from all its fields as the store's
   * catalog holds them (`#storedFields`): a field the schema in force left
   * out keeps its values, and they still refer, as a schema change never
   * changes a field that holds a record ID but to widen it.
   */
  #indexReferences(
    pinned: PinnedSchema,
    staged: readonly Staged[],
    principal: string,
    roles: WriterRoles
  ): void {
    const byKey = new Map(
      staged.map((entry) => [keyOf(entry.tableId, entry.recordId), entry])
    );
    let storeTables: ReadonlyMap<string, string> | undefined;
    const tableIdOf = (name: string): string | undefined => {
      storeTables ??= new Map(
        this.#tableRows().map((row) => [row.name, row.tableId])
      );
      return storeTables.get(name);
    };
    for (const { table, tableId, recordId, base, fields } of staged) {
      // A record the commit only read (a guard) or wrote unchanged keeps
      // its references as they are: they are read again only for what a
      // commit changes. One a cascade job is deleting may name a record
      // the job has deleted already (`#cascadeBatchOf`), which must never
      // refuse a commit that writes elsewhere.
      if (
        base !== undefined &&
        fields !== null &&
        storedText(fields) === base.valueJson
      ) {
        continue;
      }
      const held = new Set<string>();
      if (base !== undefined) {
        const where = and(
          eq(recordRefs.tableId, tableId),
          eq(recordRefs.recordId, recordId)
        );
        for (const row of this.#db
          .select({ to: recordRefs.toTableId, id: recordRefs.toRecordId })
          .from(recordRefs)
          .where(where)
          .all()) {
          held.add(keyOf(row.to, row.id));
        }
        this.#db.delete(recordRefs).where(where).run();
      }
      const declared = this.#storedFields(table);
      if (fields === null || declared === undefined) {
        continue;
      }
      for (const reference of recordReferences(declared, fields)) {
        // Each place on its own: the tables it may name that it refers
        // to, held already or holding a record the writer may read. A
        // union offering several keeps only the one that holds it. Never
        // satisfied by another place holding the same ID.
        const targets = reference.tables.flatMap(({ table: name, cascade }) => {
          const toTableId = tableIdOf(name);
          const target = {
            table: name,
            tableId: toTableId ?? "",
            recordId: reference.id,
          };
          const admitted =
            toTableId !== undefined &&
            (held.has(keyOf(toTableId, reference.id)) ||
              this.#referable(pinned, byKey, principal, roles, target));
          // No new reference to a record a cascade job is deleting: its
          // plan would never delete what refers to it.
          if (
            admitted &&
            !held.has(keyOf(toTableId, reference.id)) &&
            this.#isDeleting(toTableId, reference.id)
          ) {
            throw dataErrors.create("data.deleting");
          }
          return admitted ? [{ toTableId, cascade }] : [];
        });
        if (targets.length === 0) {
          throw dataErrors.create("data.reference_invalid", {
            table,
            id: recordId,
          });
        }
        for (const { toTableId, cascade } of targets) {
          this.#db
            .insert(recordRefs)
            .values({
              tableId,
              recordId,
              toTableId,
              toRecordId: reference.id,
              cascade,
            })
            // Several places resolving to the same row cascade only if
            // every one of them says so.
            .onConflictDoUpdate({
              target: [
                recordRefs.tableId,
                recordRefs.recordId,
                recordRefs.toTableId,
                recordRefs.toRecordId,
              ],
              set: { cascade: sql`${recordRefs.cascade} AND excluded.cascade` },
            })
            .run();
        }
      }
    }
    for (const { table, tableId, recordId, base, fields, cascaded } of staged) {
      if (base === undefined || fields !== null) {
        continue;
      }
      const referred = this.#db
        .select({ one: sql`1` })
        .from(recordRefs)
        .where(
          and(
            eq(recordRefs.toTableId, tableId),
            eq(recordRefs.toRecordId, recordId)
          )
        )
        .get();
      if (referred !== undefined) {
        // The record's own table and ID, when the commit's own write
        // deleted it: nothing of what refers to it, which may be another's.
        // A record a cascade would have taken may be another's too, and
        // one the writer can't read: then nothing is named.
        throw cascaded === true
          ? dataErrors.create("data.referenced")
          : dataErrors.create("data.referenced", { table, id: recordId });
      }
    }
  }

  /**
   * Whether record `target` exists once the commit's `staged` records are
   * written, and `principal` with `roles` may read it under the pinned
   * schema's access: its table's read mode admits them, for an `owner`
   * table the record is theirs (one this commit inserts is), and its
   * table's read rules admit them to it as it is then.
   */
  #referable(
    pinned: PinnedSchema,
    staged: ReadonlyMap<string, Staged>,
    principal: string,
    roles: WriterRoles,
    target: { table: string; tableId: string; recordId: string }
  ): boolean {
    const declared = Object.hasOwn(pinned.manifest.tables, target.table)
      ? pinned.manifest.tables[target.table]
      : undefined;
    const mode = declared?.access.read;
    const admitted =
      mode === "owner" ||
      (mode === "appMembers" && (roles.appMember || roles.appBuilder)) ||
      (mode === "appBuilders" && roles.appBuilder);
    if (!admitted) {
      return false;
    }
    const after = this.#recordAfter(staged, principal, target);
    return (
      after !== undefined &&
      (mode !== "owner" || after.owner === principal) &&
      this.#ruleAdmits(
        ruleSql(declared?.rules?.read, { principal, ...roles }),
        after.fields,
        after.owner
      )
    );
  }

  /**
   * The owner and fields of record `target` once the commit's `staged`
   * records are written, or undefined when it doesn't exist then.
   */
  #recordAfter(
    staged: ReadonlyMap<string, Staged>,
    principal: string,
    target: { tableId: string; recordId: string }
  ): { owner: string; fields: StoreFields } | undefined {
    const entry = staged.get(keyOf(target.tableId, target.recordId));
    if (entry === undefined) {
      const row = this.#db
        .select({ owner: records.ownerId, valueJson: records.valueJson })
        .from(records)
        .where(
          and(
            eq(records.tableId, target.tableId),
            eq(records.recordId, target.recordId)
          )
        )
        .get();
      return row === undefined
        ? undefined
        : { owner: row.owner, fields: fieldsOf(row) };
    }
    return entry.fields === null
      ? undefined
      : { owner: entry.base?.ownerId ?? principal, fields: entry.fields };
  }

  /**
   * Whether `rows` (one direction of a table's row rules as a condition,
   * `ruleSql`) admits a record of these `fields` and `owner`: run by
   * SQLite over the record as a commit leaves it, so a write is decided by
   * the very condition a read of the stored record is. No condition admits
   * every record.
   */
  #ruleAdmits(
    rows: Fragment | undefined,
    fields: StoreFields,
    owner: string
  ): boolean {
    if (rows === undefined) {
      return true;
    }
    const [row] = this.ctx.storage.sql
      .exec<{ admitted: number }>(
        `SELECT ${rows.sql} AS admitted FROM (SELECT ? AS value_json, ? AS owner_id)`,
        ...rows.params,
        storedText(fields),
        owner
      )
      .toArray();
    return row?.admitted === 1;
  }

  /**
   * Writes what a commit (or a preview) staged, changing only the records
   * it changed, stamped with `now`, the time core staged them.
   */
  #flush(
    staged: readonly Staged[],
    ownerId: string,
    schemaHash: string,
    now: number
  ): void {
    // The tables whose records this commit changes: each one's generation
    // moves on once, so a read of it (even one that matched nothing) is
    // known to be stale.
    const changed = new Set<string>();
    for (const { table, tableId, recordId, base, fields } of staged) {
      const where = and(
        eq(records.tableId, tableId),
        eq(records.recordId, recordId)
      );
      if (fields === null) {
        if (base !== undefined) {
          this.#db.delete(records).where(where).run();
          changed.add(tableId);
        }
        continue;
      }
      // Each write's fields were within the limit, but a patch merges
      // into what the record holds, and several patches add up: the
      // document as it would be stored is what must fit.
      const valueJson = storedText(fields);
      if (encoder.encode(valueJson).byteLength > documentMaxBytes) {
        throw dataErrors.create("data.invalid", {
          table,
          id: recordId,
          issues: [`A record holds at most ${documentMaxBytes} bytes`],
        });
      }
      if (base === undefined) {
        this.#db
          .insert(records)
          .values({
            tableId,
            recordId,
            ownerId,
            revision: 1,
            createdAt: now,
            updatedAt: now,
            valueJson,
            schemaHash,
          })
          .run();
        changed.add(tableId);
      } else if (valueJson !== base.valueJson) {
        changed.add(tableId);
        this.#db
          .update(records)
          .set({
            revision: base.revision + 1,
            updatedAt: Math.max(now, base.updatedAt),
            valueJson,
            schemaHash,
          })
          .where(where)
          .run();
      }
    }
    if (changed.size > 0) {
      this.#db
        .update(tables)
        .set({ generation: sql`${tables.generation} + 1` })
        .where(inArray(tables.tableId, [...changed]))
        .run();
      this.#moved(changed);
    }
  }

  /**
   * Moves on the generation of each table a schema change rewrote
   * records of, so every read of it is known stale, and tells its watchers.
   */
  #rewrote(tableIds: ReadonlySet<string>): void {
    if (tableIds.size === 0) {
      return;
    }
    this.#db
      .update(tables)
      .set({ generation: sql`${tables.generation} + 1` })
      .where(inArray(tables.tableId, [...tableIds]))
      .run();
    this.#moved(tableIds);
  }

  /**
   * Hands the outbox's due entries over to `consumers`, oldest first, one
   * at a time, until none are due or the drain's budget is spent (checked
   * before each entry but the first). Each is leased at the drain's time
   * when its turn comes, and settled, or put back for later when the
   * hand-over failed (settled as `outbox.attempts_exhausted` past
   * `maxAttempts`), only while the drain still holds that lease. An entry
   * whose kind nothing takes any more (its consumer went in a later
   * release, or not yet in one rolling out) fails its attempt, and is
   * settled as `outbox.no_consumer` once its attempts run out: owed to
   * nobody for good, it would otherwise keep its receipt forever. Run by
   * the alarm.
   */
  async drainOutbox(
    consumers: OutboxConsumers,
    {
      now = new Date(),
      timeoutMs = defaultTimeoutMs,
      budgetMs = defaultBudgetMs,
      maxAttempts = defaultMaxAttempts,
    }: DrainOptions = {}
  ): Promise<void> {
    assertTimeout(timeoutMs);
    const started = Date.now();
    const clock = () => now.getTime() + (Date.now() - started);
    const handed = new Set<string>();
    for (;;) {
      const due = this.#db
        .select({ id: outbox.id })
        .from(outbox)
        .where(
          and(isNull(outbox.settledAt), lte(outbox.nextAttemptAt, clock()))
        )
        .orderBy(asc(sql`rowid`))
        .limit(page)
        .all()
        .filter(({ id }) => !handed.has(id));
      if (due.length === 0) {
        return;
      }
      for (const { id } of due) {
        if (handed.size > 0 && Date.now() - started >= budgetMs) {
          return;
        }
        handed.add(id);
        // One after the other: in the order they were committed.
        // oxlint-disable-next-line no-await-in-loop -- see above
        await this.#handOne(id, consumers, clock, timeoutMs, maxAttempts);
      }
    }
  }

  /** Leases, hands over and settles entry `id`, if it is still due. */
  async #handOne(
    id: string,
    consumers: OutboxConsumers,
    clock: () => number,
    timeoutMs: number,
    maxAttempts: number
  ): Promise<void> {
    const leasedAt = clock();
    // The lease outlasts the hand-over, with room for the writes around it.
    const until = leasedAt + timeoutMs * 2;
    const leased = this.#db
      .update(outbox)
      .set({ nextAttemptAt: until })
      .where(
        and(
          eq(outbox.id, id),
          isNull(outbox.settledAt),
          lte(outbox.nextAttemptAt, leasedAt)
        )
      )
      .returning({
        kind: outbox.kind,
        intent: outbox.intent,
        attempts: outbox.attempts,
      })
      .get();
    if (leased === undefined) {
      return;
    }
    /** Settles the entry, nobody to hand it to, while this drain holds it. */
    const settleUndeliverable = (code: string): void => {
      this.#db
        .update(outbox)
        .set({ settledAt: clock(), intent: settledIntent, undeliverable: code })
        .where(
          and(
            eq(outbox.id, id),
            isNull(outbox.settledAt),
            eq(outbox.nextAttemptAt, until)
          )
        )
        .run();
    };
    // An entry a later release can't read is settled, not left to stop
    // every drain behind it: no retry would make it readable.
    const intent = intentOf(leased.intent);
    if (intent === undefined) {
      log.warn("outbox.unreadable", { id, kind: leased.kind });
      settleUndeliverable("outbox.unreadable");
      return;
    }
    const { attempts } = leased;
    // No consumer for its kind (a rollback, or a release rolling out) is
    // a failed attempt like any other: the entry waits for one to come
    // back, and settles as `outbox.no_consumer` only once its attempts
    // run out.
    const consumer = consumerFor(consumers, leased.kind);
    const result =
      consumer === undefined
        ? { failed: new Error("Nothing takes this kind of entry") }
        : await handOver(consumer, { id, intent, attempts }, timeoutMs);
    const held = and(
      eq(outbox.id, id),
      isNull(outbox.settledAt),
      eq(outbox.nextAttemptAt, until)
    );
    const handedAt = clock();
    if ("settled" in result) {
      this.#db
        .update(outbox)
        .set({
          settledAt: handedAt,
          intent: settledIntent,
          undeliverable:
            result.settled === "delivered"
              ? null
              : result.settled.undeliverable,
        })
        .where(held)
        .run();
      return;
    }
    log.warn("outbox.delivery_failed", {
      id,
      kind: leased.kind,
      ...errorFields(result.failed),
    });
    const failed = attempts + 1;
    this.#db
      .update(outbox)
      .set(
        failed >= maxAttempts
          ? {
              attempts: failed,
              settledAt: handedAt,
              intent: settledIntent,
              undeliverable:
                consumer === undefined
                  ? "outbox.no_consumer"
                  : "outbox.attempts_exhausted",
            }
          : { attempts: failed, nextAttemptAt: handedAt + backoffMs(failed) }
      )
      .where(held)
      .run();
  }

  /**
   * Expires the receipts kept long enough by `now`, and deletes the
   * tombstones kept long enough. A receipt whose outbox still owes an
   * entry is not due; one whose run is live is looked at again a day
   * later; the others lose their outcome and settled entries and stay as
   * tombstones. Each page's transaction checks again that each receipt is
   * still due, so a claim or commit landing while the runs were looked up
   * keeps its receipt. Goes on a page at a time until nothing is due or
   * its budget is spent; the next alarm continues. Run by the alarm.
   */
  async sweepReceipts(
    now: Date,
    {
      budgetMs = sweepBudgetMs,
      live: liveOf = async (runIds) => await liveRuns(this.env, runIds),
    }: SweepOptions = {}
  ): Promise<void> {
    const started = Date.now();
    const spent = () => Date.now() - started >= budgetMs;
    const at = now.getTime();
    const stillDue = (ids: readonly string[]) =>
      and(
        inArray(receipts.receiptId, [...ids]),
        isNull(receipts.expiredAt),
        lte(receipts.retainUntil, at),
        nothingOwed
      );
    for (;;) {
      const due = this.#db
        .select({ receiptId: receipts.receiptId, runId: receipts.runId })
        .from(receipts)
        .where(
          and(
            isNull(receipts.expiredAt),
            lte(receipts.retainUntil, at),
            nothingOwed
          )
        )
        .orderBy(asc(receipts.retainUntil), asc(receipts.receiptId))
        .limit(page)
        .all();
      if (due.length === 0) {
        break;
      }
      // One page after the other: each reads what the last left.
      // oxlint-disable-next-line no-await-in-loop -- see above
      const live = await liveOf(
        due.flatMap(({ runId }) => (runId === null ? [] : [runId]))
      );
      const isKept = ({ runId }: { runId: string | null }) =>
        runId !== null && live.has(runId);
      const kept = due.filter(isKept).map(({ receiptId }) => receiptId);
      const expiring = due
        .filter((receipt) => !isKept(receipt))
        .map(({ receiptId }) => receiptId);
      this.ctx.storage.transactionSync(() => {
        if (kept.length > 0) {
          this.#db
            .update(receipts)
            .set({ retainUntil: at + liveRunRecheckMs })
            .where(stillDue(kept))
            .run();
        }
        if (expiring.length === 0) {
          return;
        }
        const expired = this.#db
          .update(receipts)
          .set({
            expiredAt: at,
            outcome: null,
            committedAt: null,
            commit: null,
          })
          .where(stillDue(expiring))
          .returning({ receiptId: receipts.receiptId })
          .all()
          .map(({ receiptId }) => receiptId);
        if (expired.length > 0) {
          this.#db
            .delete(outbox)
            .where(inArray(outbox.receiptId, expired))
            .run();
        }
      });
      if (spent()) {
        return;
      }
      if (due.length < page) {
        break;
      }
    }
    // Tombstones old enough, a page at a time.
    while (!spent()) {
      const gone = this.ctx.storage.sql.exec(
        "DELETE FROM sdk_mutation_receipts WHERE rowid IN (SELECT rowid FROM sdk_mutation_receipts WHERE expired_at IS NOT NULL AND expired_at <= ? LIMIT ?)",
        at - tombstoneMs,
        page
      ).rowsWritten;
      if (gone < page) {
        return;
      }
    }
  }

  /**
   * The alarm's work: hands the outbox over to `consumers` and sweeps the
   * receipts, then sets the alarm again. Either failing (D1 out, say) is
   * logged and retried a while later, never left without an alarm.
   */
  async runAlarm(
    consumers: OutboxConsumers,
    sweep: SweepOptions = {},
    purge: PurgeOptions = {}
  ): Promise<void> {
    if (this.#deleted()) {
      let failed = false;
      try {
        await this.#purgeDeleted(purge);
      } catch (error) {
        failed = true;
        log.error("store.purge_failed", errorFields(error));
      } finally {
        await this.schedule(failed ? alarmRetryMs : alarmGapMs);
      }
      return;
    }
    let failed = false;
    try {
      await this.drainOutbox(consumers);
    } catch (error) {
      failed = true;
      log.error("store.drain_failed", errorFields(error));
    }
    try {
      await this.sweepReceipts(new Date(), sweep);
    } catch (error) {
      failed = true;
      log.error("store.sweep_failed", errorFields(error));
    }
    // Before the files' sweep, which hands the batches' audit events to
    // core with the files' own.
    try {
      this.#runCascadeJobs();
    } catch (error) {
      failed = true;
      log.error("store.cascade_failed", errorFields(error));
    }
    try {
      await this.files.sweep(this.#storeId());
    } catch (error) {
      failed = true;
      log.error("store.files_sweep_failed", errorFields(error));
    }
    try {
      this.#sweepRetention();
    } catch (error) {
      failed = true;
      log.error("store.retention_failed", errorFields(error));
    } finally {
      await this.schedule(failed ? alarmRetryMs : alarmGapMs);
    }
  }

  /**
   * Sets the alarm for the next time something is due, at least `gapMs`
   * from now, unless it is set sooner already: an outbox entry owed (of
   * any kind, as the drain settles those nothing takes), a receipt the
   * sweep may expire (none whose outbox owes an entry, which the sweep
   * skips), or a tombstone. So nothing due is left without an alarm, and
   * nothing the alarm can't act on sets one.
   */
  async schedule(gapMs = alarmGapMs): Promise<void> {
    if (this.#deleted()) {
      // Only recording it in core and its purge are left, if anything.
      // EXISTS terms rather than a UNION: SQLite here caps a compound
      // SELECT at five terms.
      const [left] = this.ctx.storage.sql
        .exec<{ left: number }>(
          `SELECT (EXISTS (SELECT 1 FROM sdk_store WHERE inventoried_at IS NULL) ${purgedTables.map((table) => `OR EXISTS (SELECT 1 FROM ${table})`).join(" ")} OR ${searchObjectsLeft}) AS left`
        )
        .toArray();
      if (left?.left === 1) {
        await this.ctx.storage.setAlarm(Date.now() + gapMs);
      }
      return;
    }
    const [entry] = this.#db
      .select({ at: min(outbox.nextAttemptAt) })
      .from(outbox)
      .where(isNull(outbox.settledAt))
      .all();
    const [receipt] = this.#db
      .select({ at: min(receipts.retainUntil) })
      .from(receipts)
      .where(and(isNull(receipts.expiredAt), nothingOwed))
      .all();
    const [tombstone] = this.#db
      .select({ at: min(receipts.expiredAt) })
      .from(receipts)
      .where(isNotNull(receipts.expiredAt))
      .all();
    // A cascade job with members left: its next batch is due now.
    const cascading = this.#db
      .select({ jobId: cascadeJobs.jobId })
      .from(cascadeJobs)
      .where(and(isNull(cascadeJobs.finishedAt), isNull(cascadeJobs.failedAt)))
      .get();
    // A failed one, tried again once it has been set aside long enough.
    const failedJob = this.#db
      .select({ at: min(cascadeJobs.failedAt) })
      .from(cascadeJobs)
      .where(
        and(isNull(cascadeJobs.finishedAt), isNotNull(cascadeJobs.failedAt))
      )
      .get();
    // Retention: the history's next due, and an import's staged rows
    // never landed.
    // The oldest by its index: a seek, never a scan.
    const staged = this.#db
      .select({ at: importRows.stagedAt })
      .from(importRows)
      .orderBy(asc(importRows.stagedAt))
      .limit(1)
      .get();
    const times = [
      historyDueAt(this.#db, Date.now()),
      typeof staged?.at === "number" ? staged.at + importStagedMs : null,
      cascading === undefined ? null : Date.now(),
      typeof failedJob?.at === "number"
        ? failedJob.at + cascadeFailedRetryMs
        : null,
      entry?.at,
      receipt?.at,
      // A file expiring, or a deleted file's bytes due for purging.
      this.files.nextDue(),
      typeof tombstone?.at === "number" ? tombstone.at + tombstoneMs : null,
    ].filter((time): time is number => typeof time === "number");
    if (times.length === 0) {
      return;
    }
    const next = Math.max(Math.min(...times), Date.now() + gapMs);
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > next) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  /** The ID of the store this object holds, once bound. */
  #storeId(): StoreId {
    const bound = this.#db.select({ storeId: store.storeId }).from(store).get();
    if (bound === undefined) {
      throw new Error("The store's object holds no store yet");
    }
    return storeIdSchema.parse(bound.storeId);
  }

  /** Whether the store was deleted. */
  #deleted(): boolean {
    const bound = this.#db
      .select({ deletedAt: store.deletedAt })
      .from(store)
      .get();
    return bound !== undefined && bound.deletedAt !== null;
  }

  /**
   * Deletes the store for `actor`, unless a receipt still refers to it:
   * one not yet expired (`data.store_in_use`), which a mutation in flight,
   * a retry still to come, a live workflow run or an outbox entry still
   * owed keeps. Checked in the transaction that marks the store deleted
   * (with who and when), so no claim can land between the check and the
   * mark; every call after it is refused (`#bind`). Answers when it was
   * deleted. Deleting a deleted store changes nothing and answers the
   * first deletion, so core can repeat one its inventory didn't record.
   * The alarm records it in core, then purges the records.
   */
  async close(storeId: StoreId, actor: AuditActor): Promise<StoreDeletionMark> {
    const id = storeIdSchema.parse(storeId);
    const deletedBy = JSON.stringify(auditActorSchema.parse(actor));
    if (this.ctx.id.name !== id) {
      throw new Error("This object holds another store");
    }
    const mark = this.ctx.storage.transactionSync((): StoreDeletionMark => {
      const now = Date.now();
      const bound = this.#db
        .select({
          storeId: store.storeId,
          deletedAt: store.deletedAt,
          deletedBy: store.deletedBy,
        })
        .from(store)
        .get();
      if (bound === undefined) {
        // Never used: nothing refers to it.
        this.#db
          .insert(store)
          .values({
            only: 1,
            storeId: id,
            createdAt: now,
            deletedAt: now,
            deletedBy,
          })
          .run();
        return { deletedAt: now, deletedBy: actor };
      }
      if (bound.storeId !== id) {
        throw new Error("This object holds another store");
      }
      // Deleted already: the first deletion's mark, whoever asks now.
      if (bound.deletedAt !== null) {
        return markOf(bound);
      }
      const [held] = this.#db
        .select({ count: count() })
        .from(receipts)
        .where(isNull(receipts.expiredAt))
        .all();
      const receiptsHeld = held?.count ?? 0;
      if (receiptsHeld > 0) {
        throw dataErrors.create("data.store_in_use", {
          receipts: receiptsHeld,
        });
      }
      this.#db.update(store).set({ deletedAt: now, deletedBy }).run();
      return { deletedAt: now, deletedBy: actor };
    });
    await this.schedule(0);
    return mark;
  }

  /**
   * A deleted store's alarm: records the deletion in core first (store-
   * deletion.ts), then purges, a page per transaction, table after table,
   * until nothing is left but the deletion mark or its time is up; the
   * next alarm continues (`schedule`).
   */
  async #purgeDeleted({
    page: purgePageSize = purgePage,
    budgetMs = purgeBudgetMs,
  }: PurgeOptions): Promise<void> {
    const bound = this.#db.select().from(store).get();
    if (bound === undefined) {
      throw new Error("A deleted store has no deletion mark");
    }
    if (bound.inventoriedAt === null) {
      const storeId = storeIdSchema.parse(bound.storeId);
      await recordStoreDeleted(this.env, storeId, markOf(bound));
      // Only once core's inventory shows it: a row that went missing
      // (or a batch that didn't land) is retried, never purged past.
      if (!(await inventoriedDeleted(this.env, storeId))) {
        throw new Error("Core's inventory doesn't show the store deleted");
      }
      this.#db.update(store).set({ inventoriedAt: Date.now() }).run();
    }
    // Its files' bytes before their rows: a purge stopped between them
    // finds the bytes gone and the rows still there, never the reverse.
    if (this.#db.select({ id: files.fileId }).from(files).get() !== undefined) {
      await this.files.purgeStore(storeIdSchema.parse(bound.storeId));
    }
    // Its search indexes first, with their triggers: no deleted record's
    // text stays behind, and no trigger runs for the records going.
    this.ctx.storage.transactionSync(() => {
      dropSearches(this.ctx.storage.sql);
    });
    const started = Date.now();
    for (const table of purgedTables) {
      for (;;) {
        const removed = this.ctx.storage.transactionSync(
          () =>
            this.ctx.storage.sql.exec(
              `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} LIMIT ?)`,
              purgePageSize
            ).rowsWritten
        );
        if (removed === 0) {
          break;
        }
        if (Date.now() - started >= budgetMs) {
          return;
        }
      }
    }
  }

  /** The ID of the table named `name`, or `data.unknown_table`. */
  #tableId(name: string): string {
    const row = this.#db
      .select({ tableId: tables.tableId })
      .from(tables)
      .where(eq(tables.name, name))
      .get();
    if (row === undefined) {
      throw dataErrors.create("data.unknown_table", { table: name });
    }
    return row.tableId;
  }

  /**
   * Holds this object to one store: the store whose ID is the object's
   * name (data-stores.ts addresses it by name), recorded by the first
   * call. A call for any other store fails, and so does every call to an
   * object not reached by a store's ID, so no object serves a store it
   * wasn't made for.
   */
  #bind(storeId: StoreId, create = true): void {
    const id = storeIdSchema.parse(storeId);
    if (this.ctx.id.name !== id) {
      throw new Error("This object holds another store");
    }
    const bound = this.#db
      .select({ storeId: store.storeId, deletedAt: store.deletedAt })
      .from(store)
      .get();
    if (bound === undefined) {
      // A read creates nothing: a store no schema was handed holds none.
      if (!create) {
        throw dataErrors.create("data.unknown_schema");
      }
      this.#db
        .insert(store)
        .values({ only: 1, storeId: id, createdAt: Date.now() })
        .run();
      return;
    }
    if (bound.storeId !== id) {
      throw new Error("This object holds another store");
    }
    // Deleted: refused whatever core's inventory says, so a deleted store
    // stays deleted even if its inventory row were wrong.
    if (bound.deletedAt !== null) {
      throw dataErrors.create("data.store_unavailable");
    }
  }
}
