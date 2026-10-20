import { ValueDefinitionError } from "@grasp-os/sdk";
import type { ValueDescriptor } from "@grasp-os/sdk";
import {
  descriptorFromText,
  manifestText,
  planPreferenceChange,
  planSchemaChange,
  readSchemaManifest,
  schemaFromDescriptor,
  SchemaDefinitionError,
  schemaHash as hashOf,
} from "@grasp-os/sdk/host";
import type {
  AcceptedPlan,
  PlannedField,
  PreferencesContract,
  ReadManifest,
  ReservedFields,
  SchemaManifest,
  SchemaPlan,
} from "@grasp-os/sdk/host";
import {
  auditActorSchema,
  auditEventSchema,
  auditProvenanceMaxItems,
} from "@grasp-os/shared/audit";
import type { AuditActor, AuditEvent } from "@grasp-os/shared/audit";
import { sha256Hex, toHex } from "@grasp-os/shared/encoding";
import { identifierSchema, storeIdSchema } from "@grasp-os/shared/ids";
import type { StoreId } from "@grasp-os/shared/ids";
import { canonicalJson, canonicalText } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { storeMaxTables } from "@grasp-os/shared/store-limits";
import {
  readRequestSchema,
  readScopeSchema,
} from "@grasp-os/shared/store-queries";
import type { ReadScope } from "@grasp-os/shared/store-queries";
import type { QueryRequest, ReadRequest } from "@grasp-os/shared/store-reads";
import {
  claimSchema,
  receiptLookupSchema,
  commitSchema,
  cascadeJobMaxRecords,
  commitMaxCascade,
  committedSchema,
  dataErrors,
  documentMaxBytes,
  migrationErrors,
  recordIdSchema,
  compatibleVersionsMax,
  schemaConsumerSchema,
  stagedWritesSchema,
  storeIntentSchema,
  storeMigrationSchema,
  receiptScopeSchema,
  storedFieldsSchema,
  tableNameSchema,
} from "@grasp-os/shared/stores";
import type {
  AppliedContract,
  ClaimInput,
  Claimed,
  Commit,
  Committed,
  DefinedTables,
  MigrationFailure,
  ReceiptLookup,
  ReceiptStanding,
  SchemaConsumer,
  StagedWrites,
  StoreMigration,
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
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  max,
  min,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import {
  abandonedTargets,
  backfills,
  cascadeJobs,
  cascadeMembers,
  commitWriters,
  fileEvents,
  files,
  migrationWork,
  outbox,
  preferences,
  receipts,
  recordRefs,
  records,
  reservedFields,
  schemaActivations,
  schemas,
  store,
  tables,
} from "./db/data-store/schema.ts";
import { FileHost } from "./file-host.ts";
import type { FileHolder, FileReader } from "./file-host.ts";
import { liveRuns } from "./live-runs.ts";
import { transformBatchMaxRows } from "./migration-transform.ts";
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
import { recordBackfillAbandoned } from "./store-abandon.ts";
import { keepStoreBackfillGoing } from "./store-backfill.ts";
import { cursorKeysOf, openCursor, sealCursor } from "./store-cursors.ts";
import type { CursorBinding, CursorKeys } from "./store-cursors.ts";
import { inventoriedDeleted, recordStoreDeleted } from "./store-deletion.ts";
import type { StoreDeletionMark } from "./store-deletion.ts";
import { defaultedFieldsOf, filledIn } from "./store-fills.ts";
import type { DefaultedField, DefaultedFields } from "./store-fills.ts";
import { installIndexes, planIndexes } from "./store-indexes.ts";
import {
  dropWork,
  fieldsOf as tableFieldsOf,
  hasWork,
  isQueued,
  nextScanBatch,
  nextWorkBatch,
  outputRefusal,
  pendingMigrationsSchema,
  queueWork,
  sampleRows,
  scanOf,
  scanPositionSchema,
  scanRangeIds,
} from "./store-migrations.ts";
import type {
  MigratedTable,
  MigrationRow,
  PendingMigrations,
  ScanPosition,
} from "./store-migrations.ts";
import {
  pagePlans,
  planQuery,
  readableTable,
  readPage,
  readRecord,
  runQuery,
  validates,
} from "./store-queries.ts";
import type {
  Anchor,
  PageAnswer,
  PinnedSchema,
  QueryAnswer,
  RecordSql,
} from "./store-queries.ts";
import { recordReferences } from "./store-references.ts";

// The host of a business store (data-store.ts is its Durable Object): one
// object per store, named by the store's ID (data-stores.ts), with a SQLite database of its own that holds all
// of the store's logical tables and their records. The layout is the
// host's and fixed (db/data-store/schema.ts): a table is a row with an ID
// the store mints, a record a row with its managed fields in columns and
// its declared fields in one JSON document. No name an author chose ever
// becomes SQL: tables are found by ID, values are bound parameters.
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
//   generation (a commit, a migration or backfill batch) tells
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
 * What a read answers: its value, and the generation of the table it
 * read, at the moment it read it (`sdk_tables.generation`).
 */
export interface ReadResult {
  value: QueryAnswer;
  generations: Record<string, number>;
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
  /**
   * The fields the store filled in with their defaults (`#apply`), which
   * its writer never sent.
   */
  filled?: ReadonlySet<string>;
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
  readonly now: number;
}

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
 * screen hears of it, or spends its budget reading again. `~` starts no
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
  "sdk_tables",
] as const;

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

/** How long a failed cascade job is set aside before it is tried again. */
const cascadeFailedRetryMs = dayMs;

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

/** The most refused changes a `migration.required` lists. */
const refusalsListed = 50;

/** The store's contract as its row holds it, read back and checked. */
interface StoreContract {
  readonly hash: string;
  readonly manifest: SchemaManifest;
}

/**
 * The contract a store's row holds, checked: its text must read as a
 * manifest, be that manifest's canonical text and hash to the hash beside
 * it; otherwise `migration.metadata_corrupt`. Null when the row holds
 * none.
 */
const contractOf = async (row: {
  contractHash: string | null;
  contractManifest: string | null;
}): Promise<StoreContract | null> => {
  const { contractHash: hash, contractManifest: text } = row;
  if (hash === null && text === null) {
    return null;
  }
  if (hash === null || text === null) {
    throw migrationErrors.create("migration.metadata_corrupt");
  }
  let manifest: SchemaManifest;
  try {
    ({ manifest } = readSchemaManifest(text));
  } catch (error) {
    if (
      error instanceof SchemaDefinitionError ||
      error instanceof ValueDefinitionError
    ) {
      throw migrationErrors.create("migration.metadata_corrupt");
    }
    throw error;
  }
  if (manifestText(manifest) !== text || (await sha256Hex(text)) !== hash) {
    throw migrationErrors.create("migration.metadata_corrupt");
  }
  return { hash, manifest };
};

/** What a plan added and kept, as its receipt records it. */
const planRecord = (
  plan: AcceptedPlan,
  identities: { base: string | null; schema: string; contract: string }
): string =>
  canonicalJson({
    ...identities,
    addedTables: [...plan.addedTables],
    migratedTables: [...plan.migratedTables],
    addedFields: plan.addedFields.map(({ table, field }) => [table, field]),
    filledFields: plan.filledFields.map(({ table, field }) => [table, field]),
    addedIndexes: plan.addedIndexes.map(({ table, index }) => [table, index]),
    retainedTables: [...plan.retainedTables],
    retainedFields: plan.retainedFields.map(({ table, field }) => [
      table,
      field,
    ]),
    retainedIndexes: plan.retainedIndexes.map(({ table, index }) => [
      table,
      index,
    ]),
  });

/** A schema's change of a store's contract, worked out before it applies. */
interface ContractChange {
  /** The contract's hash as the store's row holds it: what the write compares. */
  readonly stored: string | null;
  /** The hash of the contract planned from: the row's, or one rebuilt. */
  readonly base: string | null;
  readonly hash: string;
  readonly text: string;
  readonly changed: boolean;
  readonly planHash: string;
  readonly plan: string;
  readonly consumer: SchemaConsumer | undefined;
  readonly receiptId: string | null;
  /** Applied for its consumer already: answer the receipt, write nothing. */
  readonly replay: boolean;
  /**
   * The defaulted fields the change adds to tables the contract has: to
   * fill in first, wherever those tables hold records (`fillMissing`).
   */
  readonly fills: readonly PlannedField[];
  /** The hash of the pending target as it was planned against; null for none. */
  readonly pendingSeen: string | null;
  /**
   * Whether the schema is the pending target's already (the change adds
   * nothing to it): its receipt waits on that target's backfill.
   */
  readonly onto: boolean;
  /**
   * The explicit migrations the change runs instead of filling in, with
   * the release whose transforms they are; null for none.
   */
  readonly migrations: PendingMigrations | null;
}

/** A pending target (`sdk_schema_backfills`), read back and checked. */
interface PendingTarget {
  readonly hash: string;
  readonly manifest: SchemaManifest;
  readonly baseHash: string | null;
  readonly state: "running" | "failed";
  readonly fills: readonly PlannedField[];
  readonly attempt: number;
  readonly lastBatch: number;
  readonly leaseUntil: number | null;
  readonly scanBounds: Readonly<Record<string, string>>;
  readonly scanned: number;
  readonly filled: number;
  readonly failure: BackfillFailure | null;
  readonly failureRevision: number | null;
  /** Its explicit migrations, when it runs them instead of filling. */
  readonly migrations: PendingMigrations | null;
  /** When its explicit migration was found ready (`activateReady`). */
  readonly readyAt: number | null;
}

/** Refuses a schema's explicit migration (`migration.invalid`), saying why. */
const refuseMigration = (migration: string, reason: string): never => {
  throw migrationErrors.create("migration.invalid", { migration, reason });
};

/** Where a migration's scan is, as its backfill row keeps it; null at its start. */
const cursorOf = (row: {
  cursorTable: string | null;
  cursorOwner: string | null;
  cursorCreatedAt: number | null;
  cursorRecord: string | null;
}): ScanPosition | null =>
  row.cursorTable === null ||
  row.cursorRecord === null ||
  row.cursorOwner === null ||
  row.cursorCreatedAt === null
    ? null
    : {
        tableId: row.cursorTable,
        ownerId: row.cursorOwner,
        createdAt: row.cursorCreatedAt,
        recordId: row.cursorRecord,
      };

/** The tables `pending`'s explicit migrations transform, by name. */
const migratedSet = (pending: { migrations: PendingMigrations | null }) =>
  new Set((pending.migrations?.migrations ?? []).map(([table]) => table));

/**
 * The store's pending target and its backfill, as core drives it
 * (`backfillStatus`): its run, where it is, and why it failed.
 */
export interface BackfillStatus {
  target: string;
  state: "running" | "failed";
  attempt: number;
  /** The last batch the current run committed; 0 before its first. */
  lastBatch: number;
  /** Until when the current run's lease holds; null while none holds. */
  leaseUntil: number | null;
  scanned: number;
  filled: number;
  failure: BackfillFailure | null;
  /**
   * An explicit migration whose run is done (its scan through, no work
   * left): it waits, with no run, for a release sealed on it to be made
   * current (`activateReady`).
   */
  ready: boolean;
}

/** Why a backfill failed: the record and field whose value it can't fill. */
export interface RecordFailure {
  table: string;
  field: string;
  id: string;
  reason: "invalid_value" | "too_large";
}

/**
 * Why a backfill failed: a record it can't fill, or runs handed over to
 * one after the other without any moving the scan on (`stalled`), which a
 * store error no retry mends leaves.
 */
export type BackfillFailure =
  | RecordFailure
  | MigrationFailure
  | { reason: "stalled" }
  | { reason: "ready" };

/**
 * One batch of an explicit migration for core to transform (`fillMissing`,
 * then `commitTransformed`): the records of one table, read at their
 * revisions, the migration and the release whose transform it is, and
 * where a scan batch ends.
 */
export interface MigrationBatch {
  state: "transform";
  batch: number;
  phase: "scan" | "work";
  table: string;
  migration: string;
  consumer: SchemaConsumer;
  rows: MigrationRow[];
  through: ScanPosition | null;
}

/** What one batch of a backfill (`fillMissing`) did, and where it is. */
export interface BackfillOutcome {
  state: "running" | "ready" | "complete" | "failed";
  batch: number;
  /** Records looked at and filled in by the backfill so far, all batches. */
  scanned: number;
  filled: number;
  failure: BackfillFailure | null;
}

/**
 * Whether a schema the store recorded is in force (`schemaStatus`):
 * `abandoned` when an admin abandoned the pending target that held it for
 * the consumer asked about (`abandonBackfill`), or that alone held it;
 * `incompatible` when an explicit migration left it behind
 * (`sdk_schemas.superseded_at`), for good: its records moved on.
 */
export type SchemaStatus =
  | { state: "active" }
  | { state: "abandoned" }
  | { state: "incompatible" }
  | {
      state: "pending" | "failed" | "ready";
      target: string;
      attempt: number;
      scanned: number;
      filled: number;
      failure: BackfillFailure | null;
    }
  | { state: "unknown" };

const fillsSchema = z.array(z.tuple([tableNameSchema, z.string().min(1)]));

const scanBoundsSchema = z.record(z.string(), recordIdSchema);

const migrationFailureSchema = z.strictObject({
  table: z.string(),
  id: z.string().nullable(),
  migration: z.string(),
  reason: z.enum([
    "invalid_input",
    "threw",
    "invalid_output",
    "too_large",
    "invalid_answer",
    "outside_contract",
    "reference_changed",
    "fixtures_failed",
  ]),
  issues: z.array(z.string().max(500)).max(20),
});

const failureSchema = z.union([
  z.strictObject({
    table: z.string(),
    field: z.string(),
    id: z.string(),
    reason: z.enum(["invalid_value", "too_large"]),
  }),
  migrationFailureSchema,
  z.strictObject({ reason: z.literal("stalled") }),
  // An explicit migration abandoned while ready: nothing failed.
  z.strictObject({ reason: z.literal("ready") }),
]);

/**
 * `failure` as someone other than the migration's own App is shown it:
 * what its transform threw may carry other records' content, so its
 * issues are left out.
 */
const shownFailure = (
  failure: BackfillFailure | null,
  migrations: PendingMigrations | null,
  consumer: SchemaConsumer | undefined
): BackfillFailure | null =>
  failure !== null &&
  "migration" in failure &&
  consumer?.resourceId !== migrations?.consumer[0]
    ? { ...failure, issues: [] }
    : failure;

/** A batch's transformed records, as core commits them (`commitTransformed`). */
const transformedSchema = z.strictObject({
  target: z.string().regex(/^[0-9a-f]{64}$/u),
  attempt: z.number().int().min(1),
  batch: z.number().int().min(1),
  phase: z.enum(["scan", "work"]),
  table: tableNameSchema,
  through: scanPositionSchema.nullable(),
  rows: z
    .array(
      z.strictObject({
        id: recordIdSchema,
        revision: z.number().int().min(1),
        fields: storedFieldsSchema,
      })
    )
    .max(100),
  failure: migrationFailureSchema.optional(),
  /** The revision the failed record was at when the batch read it. */
  failureRevision: z.number().int().min(1).optional(),
});
export type TransformedBatch = z.input<typeof transformedSchema>;

/**
 * A failed pending target an admin abandoned (`abandonBackfill`): what
 * its backfill had done and why it failed, the schemas and the consumers'
 * receipts it took out of force, the fields it reserved, and who
 * abandoned it when. The record its audit event is made from alone.
 */
export interface BackfillAbandonment {
  target: string;
  attempt: number;
  scanned: number;
  filled: number;
  failure: BackfillFailure;
  schemas: string[];
  consumers: SchemaConsumer[];
  reserved: { table: string; field: string }[];
  abandonedBy: AuditActor;
  abandonedAt: number;
}

/** An admin's abandonment of a failed target, as asked (`abandonBackfill`). */
const abandonSchema = z.strictObject({
  target: z.string().regex(/^[0-9a-f]{64}$/u),
  attempt: z.number().int().min(1),
});
export type BackfillAbandon = z.input<typeof abandonSchema>;

const consumersSchema = z.array(z.tuple([z.string(), z.number().int().min(1)]));

const plannedFieldsSchema = z.array(z.tuple([z.string(), z.string()]));

/** An abandonment as its row (`sdk_abandoned_targets`) keeps it, read back. */
const abandonmentOf = (
  row: typeof abandonedTargets.$inferSelect
): BackfillAbandonment => ({
  target: row.targetHash,
  attempt: row.attempt,
  scanned: row.scanned,
  filled: row.filled,
  failure: failureSchema.parse(JSON.parse(row.failure)),
  schemas: z.array(z.string()).parse(JSON.parse(row.schemas)),
  consumers: consumersSchema
    .parse(JSON.parse(row.consumers))
    .map(([resourceId, resourceVersion]) => ({ resourceId, resourceVersion })),
  reserved: plannedFieldsSchema
    .parse(JSON.parse(row.reserved))
    .map(([table, field]) => ({ table, field })),
  abandonedBy: auditActorSchema.parse(JSON.parse(row.abandonedBy)),
  abandonedAt: row.abandonedAt,
});

/** Hand-overs in a row without progress that fail a backfill as stalled. */
export const backfillStallLimit = 3;

const outcomeSchema = z.strictObject({
  state: z.enum(["running", "ready", "complete", "failed"]),
  batch: z.number().int().min(1),
  scanned: z.number().int().min(0),
  filled: z.number().int().min(0),
  failure: failureSchema.nullable(),
});

/** What a backfill's batch answered (`fillMissing`), read back from JSON. */
export const backfillBatchSchema = z.union([
  z.strictObject({
    state: z.literal("transform"),
    batch: z.number().int().min(1),
    phase: z.enum(["scan", "work"]),
    table: tableNameSchema,
    migration: z.string().min(1),
    consumer: schemaConsumerSchema,
    rows: z.array(
      z.strictObject({
        id: recordIdSchema,
        owner: z.string(),
        revision: z.number().int().min(1),
        fields: storedFieldsSchema,
      })
    ),
    through: scanPositionSchema.nullable(),
  }),
  outcomeSchema,
]);

/** Records one batch of a backfill looks at, at most (spec 17.2). */
export const backfillBatchSize = 100;

/**
 * How long a backfill run's lease holds past its last batch: a new run
 * takes over (`restartBackfill`) only once it ran out, so a run that is
 * slow but still going is never raced by its replacement.
 */
export const backfillLeaseMs = 5 * 60 * 1000;

const backfillTargetSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/** Releases of one App asked about together (`compatibleVersions`). */
const releaseCandidatesSchema = z
  .array(
    z.strictObject({
      resourceVersion: z.number().int().min(1),
      schemaHash: backfillTargetSchema,
    })
  )
  .max(compatibleVersionsMax);

/** What a migration's dry run asks the store to sample (`sampleMigration`). */
const migrationSampleSchema = z.strictObject({
  table: tableNameSchema,
  migration: z.string().min(1).max(128),
  consumer: z.strictObject({
    resourceId: z.string().min(1),
    resourceVersion: z.number().int().min(1),
  }),
  limit: z.number().int().min(1).max(transformBatchMaxRows),
});

/**
 * A migration's dry-run outputs, as core asks the store to check them
 * (`checkSampleOutputs`): each sampled record's ID, the revision it was
 * sampled at, and its transform's output.
 */
const sampleOutputsSchema = z.strictObject({
  table: tableNameSchema,
  migration: z.string().min(1).max(128),
  consumer: z.strictObject({
    resourceId: z.string().min(1),
    resourceVersion: z.number().int().min(1),
  }),
  outputs: z
    .array(
      z.strictObject({
        id: recordIdSchema,
        revision: z.number().int().min(1),
        fields: storedFieldsSchema,
      })
    )
    .max(transformBatchMaxRows),
});

/** One batch of a backfill, as its run asks for it (`fillMissing`). */
const backfillStepSchema = z.strictObject({
  target: backfillTargetSchema,
  attempt: z.number().int().min(1),
  batch: z.number().int().min(1),
});
export type BackfillStep = z.input<typeof backfillStepSchema>;

/** A backfill run taking over from one that ended (`restartBackfill`). */
const backfillRestartSchema = z.strictObject({
  target: backfillTargetSchema,
  attempt: z.number().int().min(1),
  ending: z.boolean().optional(),
});
export type BackfillRestart = z.input<typeof backfillRestartSchema>;

/**
 * Whether a schema planned onto a contract (`plan`) is covered by it:
 * accepted, and adding no table and no field, so every table and field it
 * needs is there as it declares it. What it lists of indexes differs
 * freely (its own are installed whatever the contract lists), and fields
 * the contract keeps that it leaves out don't count. A release whose
 * schema its store's contract covers runs on the store.
 */
const covered = (plan: SchemaPlan): boolean =>
  plan.accepted &&
  plan.addedTables.length === 0 &&
  plan.addedFields.length === 0;

/**
 * The plan of `target` onto the pending target, when the pending target
 * covers it (`covered`); otherwise refused: a
 * change past the pending target waits until that is in force
 * (`migration.pending`, retryable), or needs a migration once its
 * backfill failed (`migration.backfill_failed`).
 */
const ontoPending = (
  pending: PendingTarget,
  target: SchemaManifest,
  consumer: SchemaConsumer | undefined
): AcceptedPlan => {
  // A failed target refuses even a schema it holds: a release sealed on
  // it couldn't run until the backfill is retried (`retryBackfill`).
  if (pending.state === "failed") {
    const failure = shownFailure(pending.failure, pending.migrations, consumer);
    throw migrationErrors.create("migration.backfill_failed", {
      target: pending.hash,
      attempt: pending.attempt,
      failure: failure === null ? null : { ...failure },
    });
  }
  const onto = planSchemaChange(pending.manifest, target);
  if (onto.accepted && covered(onto)) {
    return onto;
  }
  throw migrationErrors.create("migration.pending", {
    retryable: true,
    scanned: pending.scanned,
    filled: pending.filled,
  });
};

/**
 * When the alarm next looks after a running backfill (#keepBackfillGoing):
 * when its run's lease runs out, unless it looked since; otherwise a
 * lease's time after it last looked (or the target became pending). So a
 * run that renews its lease is never asked after, and one whose lease
 * ran out while the engine still has it alive is asked after once a
 * lease, not every second.
 */
const backfillDueAt = (row: {
  leaseUntil: number | null;
  lookedAt: number | null;
  createdAt: number;
}): number =>
  row.leaseUntil !== null && row.leaseUntil > (row.lookedAt ?? 0)
    ? row.leaseUntil
    : (row.lookedAt ?? row.createdAt) + backfillLeaseMs;

/** A pending target, as `backfillStatus` reports it. */
const statusOf = (pending: PendingTarget): BackfillStatus => ({
  target: pending.hash,
  state: pending.state,
  attempt: pending.attempt,
  lastBatch: pending.lastBatch,
  leaseUntil: pending.leaseUntil,
  scanned: pending.scanned,
  filled: pending.filled,
  failure: pending.failure,
  ready: pending.readyAt !== null,
});

/**
 * The fields `entry` stages, with the defaulted fields it lacks filled in;
 * `data.invalid`, naming the fields filled in, when that makes its
 * document too large, so a writer that never sent them learns why.
 */
const filledInWithin = (
  entry: Staged,
  defaulted: readonly DefaultedField[] | undefined
): StoreFields => {
  const written = entry.fields ?? {};
  const fields = filledIn(written, defaulted);
  if (
    fields !== written &&
    encoder.encode(storedText(fields)).byteLength > documentMaxBytes
  ) {
    const filled = Object.keys(fields).filter(
      (name) => !Object.hasOwn(written, name)
    );
    throw dataErrors.create("data.invalid", {
      table: entry.table,
      id: entry.recordId,
      issues: [
        `A record holds at most ${documentMaxBytes} bytes, with the defaults filled in of: ${filled.join(", ")}`,
      ],
    });
  }
  return fields;
};

/** The IDs of the schema's tables, and of every table the store holds. */
const definedTables = (
  names: readonly string[],
  all: readonly { name: string; tableId: string }[]
): Pick<DefinedTables, "tables" | "storeTables"> => {
  const schemaTables = new Set(names);
  return {
    tables: Object.fromEntries(
      all
        .filter(({ name }) => schemaTables.has(name))
        .map(({ name, tableId }) => [name, tableId])
    ),
    storeTables: Object.fromEntries(
      all.map(({ name, tableId }) => [name, tableId])
    ),
  };
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
export class StoreHost {
  readonly ctx: DurableObjectState;
  readonly env: Env;
  readonly #db: DrizzleSqliteDODatabase;
  /**
   * Told, by name, the tables whose generation moved on and the
   * generation each is at now, once the write that moved them is over
   * (data-store.ts tells its live queries): a commit's, a migration
   * batch's or a backfill batch's alike. Unset, nobody is told.
   */
  onTablesMoved: ((tables: Record<string, number>) => void) | undefined;
  /** Tables moved since `onTablesMoved` was last told, by ID. */
  readonly #movedIds = new Set<string>();
  /** The store's cursor keys, once derived (`#cursorKeys`). */
  #keys: CursorKeys | undefined;
  /** Each schema read so far, by hash (`#pinned`). */
  readonly #schemas = new Map<string, PinnedSchema>();
  /**
   * Moved on by every abandonment (`abandonBackfill`): a schema read while
   * one committed isn't kept (`#pinned`), so none taken out of force stays
   * cached.
   */
  #schemasGeneration = 0;
  /** The store's contract as last read, by its hash (`#contractNow`). */
  #contract: StoreContract | undefined;
  /** The defaulted fields of each contract read so far, by hash. */
  readonly #defaults = new Map<string, DefaultedFields>();

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
   * Applies the schema whose manifest is `manifest` (its JSON text) to the
   * store: its tables, its indexes, and the store's data contract, for
   * `consumer` when one is named; answers the schema's hash, every
   * table's ID by name and what it did to the contract. The manifest is
   * untrusted: it is read as `readSchemaManifest` reads it, bounded and
   * strict, and declared again through the SDK's checks, and the hash is
   * computed here, from its canonical text, never taken from the caller.
   * A schema that fails a check is refused (`data.invalid_schema`, with
   * the check's code).
   *
   * The contract (spec 17.4) is every table and field of every schema
   * the store accepted: a schema is applied only when the change it makes
   * to it is safe (`planSchemaChange`: new tables, new optional or
   * defaulted fields, new or redefined indexes; tables and optional
   * fields left out are kept), and refused otherwise
   * (`migration.required`, listing each change and why), before anything
   * is written. So every record the store holds fits the contract, and
   * every version sealed on it stays compatible, a rollback included.
   *
   * A defaulted field added to a table that holds records doesn't fit
   * them until they have it: the contract the change plans is kept as the
   * store's pending target (`sdk_schema_backfills`), apart from the
   * contract, which moves to it only once a backfill has filled the field
   * in everywhere (`fillMissing`); every commit from then on fills in
   * what it writes. A schema applied with explicit migrations
   * (`migrations`, checked by `#requireMigrations`) may also add required
   * fields and change fields of the tables they transform
   * (`planSchemaChange`'s `migrated`): it is pending while those tables
   * hold records, until the transforms rewrote them all
   * (store-migrations.ts, `commitTransformed`), and its activation leaves
   * behind the schemas it no longer fits (`#supersede`). The receipt
   * names the pending contract and says it is pending. While a target is pending, a schema it holds already is
   * taken onto it, and any other change is refused (`migration.pending`,
   * retryable; `migration.backfill_failed` once its backfill failed,
   * until an admin abandons it, `abandonBackfill`). A field an abandoned
   * target added is reserved: added again only as it was
   * (`reserved_field_changed` otherwise). The contract is checked against the
   * store's own recorded schemas on every call: each must fit it
   * unchanged, or it is `migration.metadata_corrupt`, as is one whose text
   * doesn't read, isn't canonical or doesn't hash to its hash. A store
   * whose row holds no contract has it rebuilt from those recorded
   * schemas, folded oldest first as they were accepted; it refuses
   * (`migration.metadata_missing`) only when that fold refuses, or holds
   * records without any recorded schema. Nothing is guessed.
   *
   * Everything lands in one transaction, or nothing does: new tables with
   * the IDs minted for them (a name differing from an existing one only
   * in case is refused, as is one past `storeMaxTables`), a physical
   * index for each declared index the store doesn't hold yet
   * (store-indexes.ts; `data.too_many_indexes` past `storeMaxIndexes`),
   * the manifest under its hash, the contract, compared and set against
   * the one the change was planned from, and the consumer's receipt
   * (`sdk_schema_activations`). That transaction is the store's lease:
   * two schemas applied at once are applied one after the other, each
   * against the contract the other left, and a crash or a failed index
   * leaves the contract as it was. Applying a schema again writes nothing
   * new and answers its first receipt. Nothing is ever renamed, dropped
   * or rewritten here: no record changes (a backfill changes them, a
   * bounded batch at a time, `fillMissing`).
   */
  async defineTables(
    storeId: StoreId,
    manifest: string,
    consumer?: SchemaConsumer,
    migrations: readonly StoreMigration[] = []
  ): Promise<DefinedTables> {
    const read = readSchema(manifest);
    const named =
      consumer === undefined
        ? undefined
        : dataErrors.parse("data.invalid", schemaConsumerSchema, consumer);
    const declared = dataErrors.parse(
      "data.invalid",
      z.array(storeMigrationSchema).max(16),
      migrations
    );
    const schemaHash = await hashOf(read.manifest);
    const names = Object.keys(read.manifest.tables);
    const text = manifestText(read.manifest);
    // Hashing is asynchronous and a transaction isn't: so the contract is
    // read and the change planned, and the IDs of new tables minted and
    // their indexes planned, from the store as it is; then everything
    // lands in one transaction, which checks first that the tables and
    // the contract are still what they were planned from. Should another
    // call change either in between, it plans again.
    for (let attempt = 1; ; attempt += 1) {
      const before = this.#tableRows();
      // Planned before anything is written.
      // oxlint-disable-next-line no-await-in-loop -- see above
      const change = await this.#planContract(
        read.manifest,
        schemaHash,
        named,
        declared
      );
      const known = new Map(before.map(({ name, tableId }) => [name, tableId]));
      const planned = Object.fromEntries(
        names.map((name) => [name, known.get(name) ?? crypto.randomUUID()])
      );
      // Planned table by table; nothing is written yet.
      // oxlint-disable-next-line no-await-in-loop -- see above
      const plan = await planIndexes(read.manifest, planned);
      const defined = this.ctx.storage.transactionSync(() =>
        this.#defineIn(storeId, before, planned, plan, schemaHash, text, change)
      );
      if (defined !== null) {
        // A target it made pending gets the alarm's look (#keepBackfillGoing).
        // oxlint-disable-next-line no-await-in-loop -- once, then it returns
        await this.schedule();
        return { schemaHash, ...defined };
      }
      if (attempt >= 3) {
        // Lost to other schemas applied at once, each time: refused as
        // retryable, never left to a generic failure.
        throw migrationErrors.create("migration.busy", { retryable: true });
      }
    }
  }

  /**
   * How `target` changes the store's contract (see `defineTables`), from
   * the contract its row holds now; refused when it needs a migration or
   * the contract can't be trusted.
   */
  /**
   * The contract the store's row holds, as `#planContract` reads it;
   * `data.store_unavailable` for a store being deleted.
   */
  #liveContractRow():
    | { contractHash: string | null; contractManifest: string | null }
    | undefined {
    const row = this.#db
      .select({
        contractHash: store.contractHash,
        contractManifest: store.contractManifest,
        deletedAt: store.deletedAt,
      })
      .from(store)
      .get();
    if (row !== undefined && row.deletedAt !== null) {
      throw dataErrors.create("data.store_unavailable");
    }
    return row;
  }

  async #planContract(
    target: SchemaManifest,
    schemaHash: string,
    consumer: SchemaConsumer | undefined,
    migrations: readonly z.output<typeof storeMigrationSchema>[] = []
  ): Promise<ContractChange> {
    const row = this.#liveContractRow();
    this.#requireTablesFit(target);
    const pending = this.#pendingTarget();
    const { stored, base } = await this.#currentContract(row, pending);
    const pendingSeen = pending?.hash ?? null;
    const baseHash = base?.hash ?? null;
    // Applied for this consumer already: its receipt is the answer, after
    // the checks above, and nothing is planned or written again, so a
    // retry never moves the contract (nor the indexes it lists) under a
    // receipt that recorded another change.
    const { receiptId, kept } = await this.#receiptOf(consumer, schemaHash);
    if (kept !== undefined) {
      return {
        stored,
        base: baseHash,
        hash: stored ?? baseHash ?? "",
        text: "",
        changed: false,
        planHash: kept.planHash,
        plan: "",
        consumer,
        receiptId,
        replay: true,
        fills: [],
        pendingSeen,
        onto: false,
        migrations: null,
      };
    }
    const { plan, migrated } = this.#acceptedPlan(
      base?.manifest ?? null,
      target,
      { migrations, schemaHash, consumer }
    );
    // While a target is pending, the contract moves to it and nowhere
    // else: a schema it holds already waits on its backfill; one that
    // would change it further waits until it is in force (or, failed,
    // needs a migration).
    if (plan.changed && pending !== null && covered(plan)) {
      // Covered by the contract in force, an older release's indexes
      // aside: applied without moving the contract, which waits on the
      // pending target alone.
      const record = planRecord(plan, {
        base: baseHash,
        schema: schemaHash,
        contract: stored ?? "",
      });
      return {
        stored,
        base: baseHash,
        hash: stored ?? "",
        text: "",
        changed: false,
        planHash: await sha256Hex(record),
        plan: record,
        consumer,
        receiptId,
        replay: false,
        fills: [],
        pendingSeen,
        onto: false,
        migrations: null,
      };
    }
    if (plan.changed && pending !== null) {
      const record = planRecord(ontoPending(pending, target, consumer), {
        base: baseHash,
        schema: schemaHash,
        contract: pending.hash,
      });
      return {
        stored,
        base: baseHash,
        hash: pending.hash,
        text: "",
        changed: true,
        planHash: await sha256Hex(record),
        plan: record,
        consumer,
        receiptId,
        replay: false,
        fills: [],
        pendingSeen,
        onto: true,
        migrations: null,
      };
    }
    const contractText = manifestText(plan.contract);
    const hash = await sha256Hex(contractText);
    const record = planRecord(plan, {
      base: baseHash,
      schema: schemaHash,
      contract: hash,
    });
    return {
      stored,
      base: baseHash,
      hash,
      text: contractText,
      changed: plan.changed,
      planHash: await sha256Hex(record),
      plan: record,
      consumer,
      receiptId,
      replay: false,
      fills: plan.filledFields,
      pendingSeen,
      onto: false,
      migrations: plan.changed ? migrated : null,
    };
  }

  /**
   * The plan of `target` onto `contract`, with the explicit migrations
   * it is applied with (checked, `#requireMigrations`); refused
   * (`migration.required`, listing each change and why) when a change
   * needs a migration none covers.
   */
  #acceptedPlan(
    contract: SchemaManifest | null,
    target: SchemaManifest,
    {
      migrations,
      schemaHash,
      consumer,
    }: {
      migrations: readonly z.output<typeof storeMigrationSchema>[];
      schemaHash: string;
      consumer: SchemaConsumer | undefined;
    }
  ): { plan: AcceptedPlan; migrated: PendingMigrations | null } {
    const migrated = this.#requireMigrations(migrations, {
      schemaHash,
      consumer,
      contract,
    });
    const plan = planSchemaChange(
      contract,
      target,
      this.#reservedFields(),
      new Set(migrated?.migrations.map(([table]) => table))
    );
    if (!plan.accepted) {
      throw migrationErrors.create("migration.required", {
        changes: plan.refused.slice(0, refusalsListed).map((refusal) => ({
          ...refusal,
        })),
      });
    }
    if (migrated !== null && !plan.changed) {
      // The contract holds the schema already: nothing is left to
      // transform, and running the transform again would rewrite records
      // the contract describes.
      refuseMigration(migrated.migrations[0]?.[1] ?? "", "nothing_to_migrate");
    }
    return { plan, migrated };
  }

  /**
   * The explicit migrations a schema is applied with, checked against
   * the store (`migration.invalid`, naming the migration and why): a
   * consumer whose release holds their transforms, each to `schemaHash`
   * itself, one per table. A migration of a table the contract doesn't
   * hold (a new store, a new table) has nothing to transform and is left
   * out. One of a table that holds records must come from a schema the
   * store recorded, still holds in force, that declares the table and
   * that the contract in force covers: the records it reads were written
   * as that schema has them. Null for none left.
   */
  #requireMigrations(
    migrations: readonly z.output<typeof storeMigrationSchema>[],
    {
      schemaHash,
      consumer,
      contract,
    }: {
      schemaHash: string;
      consumer: SchemaConsumer | undefined;
      contract: SchemaManifest | null;
    }
  ): PendingMigrations | null {
    if (migrations.length === 0) {
      return null;
    }
    if (consumer === undefined) {
      return refuseMigration(migrations[0]?.name ?? "", "no_consumer");
    }
    const tableIds = new Map(
      this.#tableRows().map(({ name, tableId }) => [name, tableId])
    );
    const tablesSeen = new Set<string>();
    const kept: [string, string][] = [];
    for (const { name, table, fromSchema, toSchema } of migrations) {
      if (toSchema !== schemaHash) {
        refuseMigration(name, "wrong_target");
      }
      if (tablesSeen.has(table)) {
        refuseMigration(name, "shared_table");
      }
      tablesSeen.add(table);
      if (contract === null || !Object.hasOwn(contract.tables, table)) {
        continue;
      }
      if (this.#holdsRecords(tableIds.get(table))) {
        this.#requireSource(name, table, fromSchema, contract);
      }
      kept.push([table, name]);
    }
    if (kept.length === 0) {
      return null;
    }
    return {
      consumer: [consumer.resourceId, consumer.resourceVersion],
      schema: schemaHash,
      migrations: kept.toSorted(([a], [b]) => a.localeCompare(b)),
    };
  }

  /**
   * Refuses (`migration.invalid`, `unknown_source`) a migration of `table`
   * from `fromSchema` unless the store recorded it, holds it in force, it
   * declares `table`, and `contract` covers it.
   */
  #requireSource(
    name: string,
    table: string,
    fromSchema: string,
    contract: SchemaManifest
  ): void {
    const source = this.#db
      .select({
        manifest: schemas.manifest,
        abandonedAt: schemas.abandonedAt,
        supersededAt: schemas.supersededAt,
      })
      .from(schemas)
      .where(eq(schemas.schemaHash, fromSchema))
      .get();
    const manifest =
      source === undefined
        ? undefined
        : readSchemaManifest(source.manifest).manifest;
    if (
      source === undefined ||
      manifest === undefined ||
      source.abandonedAt !== null ||
      source.supersededAt !== null ||
      !Object.hasOwn(manifest.tables, table) ||
      !covered(planSchemaChange(contract, manifest))
    ) {
      refuseMigration(name, "unknown_source");
    }
  }

  /**
   * Refuses what the store's tables refuse of `target`, first and with its
   * own code, as the transaction would: a union holding both would only
   * say it needs a migration.
   */
  #requireTablesFit(target: SchemaManifest): void {
    const held = this.#tableRows();
    const byKey = new Map(held.map(({ name }) => [name.toLowerCase(), name]));
    for (const name of Object.keys(target.tables)) {
      const existing = byKey.get(name.toLowerCase());
      if (existing !== undefined && existing !== name) {
        throw dataErrors.create("data.table_conflict", {
          table: name,
          existing,
        });
      }
    }
    const after = new Set([
      ...held.map(({ name }) => name),
      ...Object.keys(target.tables),
    ]);
    if (after.size > storeMaxTables) {
      throw dataErrors.create("data.too_many_tables");
    }
  }

  /**
   * The ID of `consumer`'s receipt for the schema `schemaHash` (null when
   * no consumer is named), and the receipt itself if the store keeps one.
   */
  async #receiptOf(
    consumer: SchemaConsumer | undefined,
    schemaHash: string
  ): Promise<{
    receiptId: string | null;
    kept: { planHash: string } | undefined;
  }> {
    if (consumer === undefined) {
      return { receiptId: null, kept: undefined };
    }
    const receiptId = await sha256Hex(
      canonicalJson({
        resourceId: consumer.resourceId,
        resourceVersion: consumer.resourceVersion,
        schemaHash,
      })
    );
    const kept = this.#db
      .select({
        planHash: schemaActivations.planHash,
        abandonedAt: schemaActivations.abandonedAt,
      })
      .from(schemaActivations)
      .where(eq(schemaActivations.receiptId, receiptId))
      .get();
    // Its pending target was abandoned: its release never runs here, and
    // isn't made pending again under the receipt that recorded that.
    if (kept !== undefined && kept.abandonedAt !== null) {
      throw migrationErrors.create("migration.abandoned");
    }
    return { receiptId, kept };
  }

  /**
   * The store's contract (see `defineTables`), checked against what the
   * store itself recorded: every schema it holds must fit the contract,
   * adding no table or field to it, or the contract is `migration.metadata_corrupt`, whatever
   * its hash says. A store whose row holds no contract has it rebuilt from
   * its own recorded schemas, oldest first, each planned onto the ones
   * before it, as they were accepted; nothing is guessed, so a fold that
   * refuses is `migration.metadata_missing`, and so are records without
   * any recorded schema. Null for a store holding nothing.
   */
  async #currentContract(
    row:
      | { contractHash: string | null; contractManifest: string | null }
      | undefined,
    pending: PendingTarget | null
  ): Promise<{ stored: string | null; base: StoreContract | null }> {
    const recorded = this.#recordedSchemas();
    const kept = row === undefined ? null : await contractOf(row);
    if (pending !== null) {
      // A pending target is checked as the contract is, and moves on from
      // the contract the row holds, never from one rebuilt.
      if (
        kept === null ||
        pending.baseHash !== kept.hash ||
        (await sha256Hex(manifestText(pending.manifest))) !== pending.hash
      ) {
        throw migrationErrors.create("migration.metadata_corrupt");
      }
      const onto = planSchemaChange(
        kept.manifest,
        pending.manifest,
        {},
        migratedSet(pending)
      );
      if (!onto.accepted || !onto.changed) {
        throw migrationErrors.create("migration.metadata_corrupt");
      }
    }
    if (kept !== null) {
      // The store's schemas fit the contract or the pending target, when
      // there is one: the schema that made it pending is recorded already.
      for (const manifest of recorded) {
        // Its tables, fields and access all in the contract already; its
        // indexes are physical, installed whatever the contract lists.
        if (
          !covered(planSchemaChange(kept.manifest, manifest)) &&
          (pending === null ||
            !covered(planSchemaChange(pending.manifest, manifest)))
        ) {
          throw migrationErrors.create("migration.metadata_corrupt");
        }
      }
      return { stored: kept.hash, base: kept };
    }
    if (recorded.length === 0) {
      this.#requireNoRecords();
      return { stored: null, base: null };
    }
    let folded: SchemaManifest | null = null;
    for (const manifest of recorded) {
      const plan = planSchemaChange(folded, manifest);
      if (!plan.accepted) {
        throw migrationErrors.create("migration.metadata_missing");
      }
      folded = plan.contract;
    }
    if (folded === null) {
      throw new Error("A fold of recorded schemas left no contract");
    }
    return {
      stored: null,
      base: { hash: await sha256Hex(manifestText(folded)), manifest: folded },
    };
  }

  /**
   * The store's pending target, if it has one (running or failed), read
   * back; one whose text doesn't read as a canonical manifest, or whose
   * other columns don't, is `migration.metadata_corrupt` (its hash is
   * checked with the contract, `#currentContract`). Call it inside a
   * transaction, or where nothing else interleaves.
   */
  #pendingTarget(): PendingTarget | null {
    const row = this.#db
      .select()
      .from(backfills)
      .where(sql`${backfills.state} <> 'complete'`)
      .get();
    if (row === undefined) {
      return null;
    }
    try {
      const { manifest } = readSchemaManifest(row.targetManifest);
      if (
        manifestText(manifest) !== row.targetManifest ||
        row.state === "complete"
      ) {
        throw migrationErrors.create("migration.metadata_corrupt");
      }
      return {
        hash: row.targetHash,
        manifest,
        baseHash: row.baseHash,
        state: row.state,
        fills: fillsSchema
          .parse(JSON.parse(row.fills))
          .map(([table, field]) => ({ table, field })),
        attempt: row.attempt,
        lastBatch: row.lastBatch,
        leaseUntil: row.leaseUntil,
        scanBounds: scanBoundsSchema.parse(JSON.parse(row.scanBounds)),
        scanned: row.scanned,
        filled: row.filled,
        failure:
          row.failure === null
            ? null
            : failureSchema.parse(JSON.parse(row.failure)),
        failureRevision: row.failureRevision,
        migrations:
          row.migrations === null
            ? null
            : pendingMigrationsSchema.parse(JSON.parse(row.migrations)),
        readyAt: row.readyAt,
      };
    } catch (error) {
      if (
        error instanceof SchemaDefinitionError ||
        error instanceof ValueDefinitionError ||
        error instanceof z.ZodError ||
        error instanceof SyntaxError
      ) {
        throw migrationErrors.create("migration.metadata_corrupt");
      }
      throw error;
    }
  }

  /**
   * Every schema the store recorded, oldest first (ties by hash), read
   * back; one that doesn't read is `migration.metadata_corrupt`.
   */
  #recordedSchemas(): SchemaManifest[] {
    // Not those only an abandoned target held: the contract never took
    // them; nor those a migration left behind: it moved past them.
    return this.#db
      .select({ manifest: schemas.manifest })
      .from(schemas)
      .where(and(isNull(schemas.abandonedAt), isNull(schemas.supersededAt)))
      .orderBy(asc(schemas.createdAt), asc(schemas.schemaHash))
      .all()
      .map(({ manifest }) => {
        try {
          return readSchemaManifest(manifest).manifest;
        } catch (error) {
          if (
            error instanceof SchemaDefinitionError ||
            error instanceof ValueDefinitionError
          ) {
            throw migrationErrors.create("migration.metadata_corrupt");
          }
          throw error;
        }
      });
  }

  /**
   * The fields the store reserved (`sdk_reserved_fields`), each with its
   * descriptor, read back one at a time through the SDK's descriptor
   * checks: a descriptor alone, so a reference to a table no reserved
   * field names needs no resolving. One that doesn't read is
   * `migration.metadata_corrupt`.
   */
  #reservedFields(): ReservedFields {
    const reserved: Record<string, Record<string, ValueDescriptor>> = {};
    const rows = this.#db
      .select()
      .from(reservedFields)
      .orderBy(asc(reservedFields.tableName), asc(reservedFields.fieldName))
      .all();
    for (const row of rows) {
      let descriptor: ValueDescriptor;
      try {
        ({ descriptor } = schemaFromDescriptor(row.descriptor));
      } catch (error) {
        if (error instanceof ValueDefinitionError) {
          throw migrationErrors.create("migration.metadata_corrupt");
        }
        throw error;
      }
      reserved[row.tableName] = {
        ...reserved[row.tableName],
        [row.fieldName]: descriptor,
      };
    }
    return reserved;
  }

  /**
   * Refuses (`migration.metadata_missing`) records in a store that
   * recorded no schema: there is nothing to rebuild their contract from.
   */
  #requireNoRecords(): void {
    const held = this.#db
      .select({ id: records.recordId })
      .from(records)
      .limit(1)
      .get();
    if (held !== undefined) {
      throw migrationErrors.create("migration.metadata_missing");
    }
  }

  /**
   * `defineTables`' one transaction: the schema's new tables with the IDs
   * its indexes were planned for, the indexes, the schema, the contract
   * and the consumer's receipt; null, with nothing written, if the tables
   * or the contract changed since they were read.
   */
  #defineIn(
    storeId: StoreId,
    before: readonly { name: string; tableId: string }[],
    planned: Readonly<Record<string, string>>,
    plan: Awaited<ReturnType<typeof planIndexes>>,
    schemaHash: string,
    text: string,
    change: ContractChange
  ): Omit<DefinedTables, "schemaHash"> | null {
    const names = Object.keys(planned);
    this.#bind(storeId);
    if (canonicalJson(this.#tableRows()) !== canonicalJson(before)) {
      return null;
    }
    const current = this.#db
      .select({ contractHash: store.contractHash })
      .from(store)
      .get();
    if (
      (current?.contractHash ?? null) !== change.stored ||
      (this.#pendingTarget()?.hash ?? null) !== change.pendingSeen
    ) {
      return null;
    }
    if (change.base === null) {
      // Planned from nothing: still nothing, or plan again.
      if (this.#recordedSchemas().length > 0) {
        return null;
      }
      this.#requireNoRecords();
    }
    const now = Date.now();
    for (const name of names) {
      const existing = this.#db
        .select({ name: tables.name })
        .from(tables)
        .where(eq(tables.nameKey, name.toLowerCase()))
        .get();
      if (existing !== undefined) {
        if (existing.name !== name) {
          throw dataErrors.create("data.table_conflict", {
            table: name,
            existing: existing.name,
          });
        }
        continue;
      }
      this.#db
        .insert(tables)
        .values({
          tableId: planned[name] ?? crypto.randomUUID(),
          name,
          nameKey: name.toLowerCase(),
          createdAt: now,
        })
        .run();
    }
    const all = this.#tableRows();
    if (all.length > storeMaxTables) {
      throw dataErrors.create("data.too_many_tables");
    }
    if (change.replay) {
      return {
        ...definedTables(names, all),
        contract: this.#receive(schemaHash, change, now),
      };
    }
    installIndexes(this.ctx.storage.sql, plan);
    // Applied again after an abandoned target held it (a later release
    // adding the reserved fields as they were): in force or pending once
    // more, as this change leaves it.
    this.#db
      .insert(schemas)
      .values({ schemaHash, manifest: text, createdAt: now })
      .onConflictDoUpdate({
        target: schemas.schemaHash,
        set: { abandonedAt: null },
      })
      .run();
    if (!change.onto && change.hash !== change.stored) {
      this.#moveContract(change, all, now);
    }
    return {
      ...definedTables(names, all),
      contract: this.#receive(schemaHash, change, now),
    };
  }

  /**
   * `#defineIn`'s move of the contract to `change`'s: at once, or kept as
   * the pending target while records lack what it adds (a fill), or a
   * migration has records to transform (`#migrateIn`).
   */
  #moveContract(
    change: ContractChange,
    all: readonly { name: string; tableId: string }[],
    now: number
  ): void {
    const byName = new Map(all.map(({ name, tableId }) => [name, tableId]));
    const toFill = change.fills.filter(({ table }) =>
      this.#holdsRecords(byName.get(table))
    );
    if (change.migrations !== null) {
      this.#migrateIn(change, toFill, byName, now);
    } else if (toFill.length > 0) {
      // A contract rebuilt from the store's schemas, its row holding
      // none, is repaired first: activation compares and sets against
      // the row's own.
      if (change.stored === null) {
        throw migrationErrors.create("migration.metadata_missing");
      }
      // Records lack a field the contract would require: the change
      // waits as the pending target until they are filled in, and
      // every commit from now on fills in what it writes (`#apply`).
      this.#makePending(change, change.stored, toFill, byName, now);
    } else {
      this.#db
        .update(store)
        .set({ contractHash: change.hash, contractManifest: change.text })
        .run();
    }
  }

  /**
   * Applies `change`, which runs explicit migrations, in `#defineIn`'s
   * transaction: refused (`migration.invalid`) when it also has defaults
   * to fill in elsewhere (`toFill`); kept as the pending target while a
   * table it migrates holds records; otherwise in force at once, leaving
   * behind the schemas it no longer fits (`#supersede`).
   */
  #migrateIn(
    change: ContractChange,
    toFill: readonly PlannedField[],
    byName: ReadonlyMap<string, string>,
    now: number
  ): void {
    const migrations = change.migrations?.migrations ?? [];
    if (toFill.length > 0) {
      throw migrationErrors.create("migration.invalid", {
        migration: migrations[0]?.[1] ?? "",
        reason: "fills_elsewhere",
      });
    }
    const holding = migrations
      .map(([table]) => ({ table, field: "" }))
      .filter(({ table }) => this.#holdsRecords(byName.get(table)));
    if (holding.length > 0) {
      if (change.stored === null) {
        throw migrationErrors.create("migration.metadata_missing");
      }
      this.#makePending(change, change.stored, holding, byName, now);
      return;
    }
    this.#db
      .update(store)
      .set({ contractHash: change.hash, contractManifest: change.text })
      .run();
    this.#supersede(readSchemaManifest(change.text).manifest, now);
  }

  /**
   * Marks every schema in force that `contract` no longer covers as left
   * behind by a migration (`sdk_schemas.superseded_at`): writes under it
   * are refused from now on (`#requireInForce`).
   */
  #supersede(contract: SchemaManifest, now: number): void {
    const behind = this.#db
      .select({ hash: schemas.schemaHash, manifest: schemas.manifest })
      .from(schemas)
      .where(and(isNull(schemas.abandonedAt), isNull(schemas.supersededAt)))
      .all()
      .filter(
        ({ manifest }) =>
          !covered(
            planSchemaChange(contract, readSchemaManifest(manifest).manifest)
          )
      )
      .map(({ hash }) => hash);
    if (behind.length > 0) {
      this.#db
        .update(schemas)
        .set({ supersededAt: now })
        .where(inArray(schemas.schemaHash, behind))
        .run();
    }
  }

  /**
   * Keeps `change`'s contract as the store's pending target, its backfill
   * running (`sdk_schema_backfills`). A target abandoned before under the
   * same hash goes on from the run after its last, so none of its runs is
   * taken for this one's (store-backfill.ts names runs by target and run).
   */
  #makePending(
    change: ContractChange,
    base: string,
    toFill: readonly PlannedField[],
    byName: ReadonlyMap<string, string>,
    now: number
  ): void {
    const [abandoned] = this.#db
      .select({ attempt: max(abandonedTargets.attempt) })
      .from(abandonedTargets)
      .where(eq(abandonedTargets.targetHash, change.hash))
      .all();
    this.#db
      .insert(backfills)
      .values({
        attempt: (abandoned?.attempt ?? 0) + 1,
        targetHash: change.hash,
        targetManifest: change.text,
        baseHash: base,
        fills: canonicalJson(
          change.fills.map(({ table, field }) => [table, field])
        ),
        scanBounds: canonicalJson(this.#scanBounds(toFill, byName)),
        migrations:
          change.migrations === null ? null : canonicalJson(change.migrations),
        state: "running",
        createdAt: now,
      })
      .run();
  }

  /**
   * The highest record ID each table of `toFill` holds now, by table ID:
   * where its backfill's scan ends (`sdk_schema_backfills.scan_bounds`).
   */
  #scanBounds(
    toFill: readonly PlannedField[],
    byName: ReadonlyMap<string, string>
  ): Record<string, string> {
    const bounds: Record<string, string> = {};
    for (const { table } of toFill) {
      const tableId = byName.get(table);
      if (tableId === undefined || Object.hasOwn(bounds, tableId)) {
        continue;
      }
      const [highest] = this.#db
        .select({ id: max(records.recordId) })
        .from(records)
        .where(eq(records.tableId, tableId))
        .all();
      if (highest?.id !== null && highest?.id !== undefined) {
        bounds[tableId] = highest.id;
      }
    }
    return bounds;
  }

  /** Whether the table `tableId` (if any) holds a record. */
  #holdsRecords(tableId: string | undefined): boolean {
    if (tableId === undefined) {
      return false;
    }
    return (
      this.#db
        .select({ id: records.recordId })
        .from(records)
        .where(eq(records.tableId, tableId))
        .limit(1)
        .get() !== undefined
    );
  }

  /**
   * The consumer's receipt of the change (see `defineTables`): written
   * now if it has none for this schema, otherwise the one it has, whose
   * plan is the one that applied the schema first.
   */
  #receive(
    schemaHash: string,
    change: ContractChange,
    now: number
  ): AppliedContract {
    const { consumer, receiptId } = change;
    const applied: AppliedContract = {
      hash: change.hash,
      planHash: change.planHash,
      changed: change.changed,
      receiptId,
      pending: this.#pendingTarget()?.hash === change.hash,
    };
    if (consumer === undefined || receiptId === null) {
      return applied;
    }
    const kept = this.#db
      .select({
        planHash: schemaActivations.planHash,
        contractHash: schemaActivations.contractHash,
        baseHash: schemaActivations.baseHash,
      })
      .from(schemaActivations)
      .where(eq(schemaActivations.receiptId, receiptId))
      .get();
    if (kept !== undefined) {
      // The receipt's own: what its first application left, so its hash
      // and plan always describe the same change.
      return {
        hash: kept.contractHash,
        planHash: kept.planHash,
        changed: kept.contractHash !== kept.baseHash,
        receiptId,
        pending: this.#pendingTarget()?.hash === kept.contractHash,
      };
    }
    this.#db
      .insert(schemaActivations)
      .values({
        receiptId,
        resourceId: consumer.resourceId,
        resourceVersion: consumer.resourceVersion,
        schemaHash,
        baseHash: change.base,
        contractHash: change.hash,
        planHash: change.planHash,
        plan: change.plan,
        createdAt: now,
      })
      .run();
    return applied;
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
    const table = read.kind === "get" ? read.table : read.query.table;
    return this.#readIn(storeId, pinned, reader, table, preview, (statements) =>
      indexRequired(() =>
        read.kind === "get"
          ? readRecord(statements, pinned, reader, read)
          : runQuery(statements, pinned, reader, read.query)
      )
    );
  }

  /**
   * Runs `read` (of `table`) in one transaction, with the generation of
   * `table` taken first: what the read depended on, which a reader
   * compares later (store-reader.ts), handed back with its answer and
   * added to a data error it fails with (`details.generations`), since a
   * read that failed after it looked at records (`data.not_unique`,
   * `data.result_limit`, ...) depended on them as much as one that
   * answered.
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
    table: string,
    preview: Preview | undefined,
    read: (statements: RecordSql) => Answer
  ): { value: Answer; generations: Record<string, number> } {
    const run = () => {
      this.#bind(storeId, false);
      const generations = this.#generationsOf(pinned, [table]);
      let readRecords = false;
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
        const counted: RecordSql = {
          exec: <Row extends Record<string, SqlStorageValue>>(
            query: string,
            ...bindings: unknown[]
          ): SqlStorageCursor<Row> => {
            const cursor = storage.exec<Row>(query, ...bindings);
            readRecords = true;
            return cursor;
          },
        };
        return { value: read(counted), generations };
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
          });
        }
        throw error;
      }
    };
    if (preview === undefined) {
      return this.ctx.storage.transactionSync(run);
    }
    let answer:
      | { value: Answer; generations: Record<string, number> }
      | undefined;
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
    const listener = this.onTablesMoved;
    if (listener === undefined || ids.length === 0) {
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
   * model): its cursor opened first, against what this request and scope
   * bind it to, under this store's key; the page read in one transaction;
   * and the next page's cursor sealed for the same binding, when more
   * follow.
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
    const keys = await this.#cursorKeys(storeId);
    const binding: CursorBinding = {
      storeId,
      schemaHash: reader.schemaHash,
      consumer: reader.consumer,
      principal: reader.principal,
      appMember: reader.appMember,
      appBuilder: reader.appBuilder,
      table: query.table,
      index: query.index,
      range: query.range,
      filter: query.filter,
      order: query.order,
    };
    const anchor =
      terminal.cursor === null
        ? null
        : await openCursor(keys, binding, terminal.cursor);
    const { value: read, generations } = this.#readIn(
      storeId,
      pinned,
      reader,
      query.table,
      preview,
      (statements) =>
        indexRequired(() => readPage(statements, pinned, reader, query, anchor))
    );
    const value: PageAnswer =
      read.hasMore && read.last !== undefined
        ? {
            items: read.items,
            nextCursor: await sealCursor(keys, binding, read.last),
            hasMore: true,
          }
        : { items: read.items, nextCursor: null, hasMore: false };
    return { value, generations };
  }

  /**
   * The keys this store seals and tags its cursors with, derived from one
   * random key kept in its own SQLite: minted by the store's first page,
   * cleared when the store is purged, derived once per object.
   */
  async #cursorKeys(storeId: StoreId): Promise<CursorKeys> {
    if (this.#keys !== undefined) {
      return this.#keys;
    }
    const hex = this.ctx.storage.transactionSync(() => {
      this.#bind(storeId, false);
      const row = this.#db.select({ key: store.cursorKey }).from(store).get();
      if (row?.key !== null && row?.key !== undefined) {
        return row.key;
      }
      const made = toHex(crypto.getRandomValues(new Uint8Array(32)));
      this.#db.update(store).set({ cursorKey: made }).run();
      return made;
    });
    this.#keys = await cursorKeysOf(hex);
    return this.#keys;
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
   * The schema `schemaHash` as this store recorded it, with its tables'
   * IDs and its indexes' physical names: read and planned once per object,
   * since neither ever changes for a hash. `data.unknown_schema` for a
   * hash the store wasn't handed.
   */
  async #pinned(storeId: StoreId, schemaHash: string): Promise<PinnedSchema> {
    const known = this.#schemas.get(schemaHash);
    if (known !== undefined) {
      return known;
    }
    const generation = this.#schemasGeneration;
    const row = this.ctx.storage.transactionSync(() => {
      this.#bind(storeId, false);
      return this.#db
        .select({
          manifest: schemas.manifest,
          abandonedAt: schemas.abandonedAt,
        })
        .from(schemas)
        .where(eq(schemas.schemaHash, schemaHash))
        .get();
    });
    if (row === undefined) {
      throw dataErrors.create("data.unknown_schema");
    }
    // Only an abandoned target held it: nothing reads or writes under it
    // (`abandonBackfill` forgets the schemas read before).
    if (row.abandonedAt !== null) {
      throw migrationErrors.create("migration.abandoned");
    }
    const { manifest } = readSchemaManifest(row.manifest);
    const tableIds = Object.fromEntries(
      this.#db
        .select({ name: tables.name, tableId: tables.tableId })
        .from(tables)
        .all()
        .map(({ name, tableId }) => [name, tableId])
    );
    const pinned: PinnedSchema = {
      manifest,
      tableIds,
      indexes: await planIndexes(manifest, tableIds),
    };
    // Kept only if no abandonment committed while its indexes were planned;
    // a commit checks again in its transaction anyway (`#requireInForce`).
    if (generation === this.#schemasGeneration) {
      this.#schemas.set(schemaHash, pinned);
    }
    return pinned;
  }

  /**
   * Refuses (`migration.abandoned`) a schema only an abandoned target
   * held, and (`migration.incompatible_write`) one an explicit migration
   * left behind (`#supersede`): its writes no longer fit the records.
   * Call it inside the transaction that writes under the schema.
   */
  #requireInForce(schemaHash: string): void {
    const row = this.#db
      .select({
        abandonedAt: schemas.abandonedAt,
        supersededAt: schemas.supersededAt,
      })
      .from(schemas)
      .where(eq(schemas.schemaHash, schemaHash))
      .get();
    if (row !== undefined && row.abandonedAt !== null) {
      throw migrationErrors.create("migration.abandoned");
    }
    if (row !== undefined && row.supersededAt !== null) {
      throw migrationErrors.create("migration.incompatible_write");
    }
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
          })
          .run();
        return { held: { receiptId, fence: 1 } };
      }
      if (receipt.expiredAt !== null) {
        throw submissionErrors.create("submission.expired");
      }
      if (receipt.inputHash !== inputHash) {
        throw submissionErrors.create("submission.key_conflict");
      }
      if (receipt.outcome !== null) {
        return { outcome: outcomeOf(receipt.outcome) };
      }
      const fence = receipt.fence + 1;
      this.#db
        .update(receipts)
        .set({
          fence,
          deadline,
          retainUntil: Math.max(receipt.retainUntil, now + retentionMs),
        })
        .where(eq(receipts.receiptId, receiptId))
        .run();
      return { held: { receiptId, fence } };
    });
    await this.schedule();
    return claimed;
  }

  /**
   * Where the receipt of `input`'s scope and key stands, its outcome left
   * out (`ReceiptStanding`): a look, never a claim, which changes nothing
   * and runs nothing (spec 10.7.8). The scope names its principal, so a
   * receipt is only found by the scope it was claimed under.
   */
  async receiptStanding(input: ReceiptLookup): Promise<ReceiptStanding> {
    const { storeId, scope, key } = dataErrors.parse(
      "data.invalid",
      receiptLookupSchema,
      input
    );
    // As `claim` names it.
    const receiptId = await sha256Hex(
      canonicalJson({ storeId, scope: { ...scope }, key: [...key] })
    );
    try {
      // Read only: a store nothing bound yet stays unbound.
      this.#bind(storeId, false);
    } catch (error) {
      // Nothing bound: no attempt ever claimed a receipt here.
      if (dataErrors.codeOf(error) === "data.unknown_schema") {
        return { state: "none" };
      }
      throw error;
    }
    const receipt = this.#db
      .select({
        expiredAt: receipts.expiredAt,
        committedAt: receipts.committedAt,
        deadline: receipts.deadline,
        fence: receipts.fence,
      })
      .from(receipts)
      .where(eq(receipts.receiptId, receiptId))
      .get();
    if (receipt === undefined) {
      return { state: "none" };
    }
    if (receipt.expiredAt !== null) {
      return { state: "expired" };
    }
    if (receipt.committedAt !== null) {
      return { state: "committed" };
    }
    return {
      state: "claimed",
      deadline: receipt.deadline,
      fence: receipt.fence,
    };
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
      writer,
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
      // writes: an abandonment that committed since `#pinned` read it.
      this.#requireInForce(schemaHash);
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
                resourceId:
                  writer?.resourceId ?? resourceOfScope(receipt.scope),
                runId: receipt.runId,
                now,
              }),
              members: cascadeJob.members.size,
            };
      if (cascadePending !== undefined) {
        this.#requireCascadeClosed(cascadePending.job);
      }
      // The files they hold, by the same fields: the store's contract
      // fixes each field's descriptor for good, as for references.
      const contract = this.#contractNow() ?? pinned.manifest;
      // Records already holding a file, as the writer reads them now: the
      // commit's own records written, under the schema it is pinned to.
      const none: ReadonlyMap<string, Staged> = new Map();
      this.files.index(
        staged,
        principal.userId,
        (table) => contract.tables[table]?.fields,
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
      // A consumer's commit names it for good, past its receipt's retention.
      if (writer !== undefined) {
        this.#db
          .insert(commitWriters)
          .values({
            commit: counted.commits,
            receiptId: held.receiptId,
            resourceId: writer.resourceId,
            resourceVersion: writer.resourceVersion,
            principal: principal.userId,
            committedAt: now,
          })
          .run();
      }
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
    /** Whether `roles` may write `table`, and whether only their own records. */
    const writable = (table: string): { tableId: string; own: boolean } => {
      const tableId = tableIdOf(table);
      const mode = pinned.manifest.tables[table]?.access.write ?? "none";
      const admitted =
        mode === "owner" ||
        (mode === "appMembers" && (roles.appMember || roles.appBuilder)) ||
        (mode === "appBuilders" && roles.appBuilder);
      if (!admitted) {
        throw dataErrors.create("data.write_denied", { table });
      }
      return { tableId, own: mode === "owner" };
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
      const { tableId, own } = writable(write.table);
      if (write.op === "insert") {
        const entry = stage(write.table, tableId, write.id);
        if (entry.base !== undefined || entry.fields !== null) {
          throw conflict(write.table, write.id);
        }
        entry.fields = write.fields;
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
      if (write.op === "delete") {
        entry.fields = null;
      } else if (write.op === "replace") {
        // Fields the pinned table doesn't declare are a newer version's,
        // kept in the contract (`defineTables`): a replacement by an older
        // version keeps them, as a patch does, and never strips them.
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
    }
    const cascadeJob = this.#cascade(staged, stage, preview);
    // What the commit writes gets the contract's defaulted fields it
    // lacks, the pending target's included (store-fills.ts), whatever
    // schema the writer is pinned to: before its references are read and
    // its document is stored. A record it only read (a guard) or deletes
    // is left as it is.
    const defaulted = this.#defaultedFields();
    for (const entry of staged.values()) {
      if (
        entry.fields !== null &&
        (entry.base === undefined ||
          storedText(entry.fields) !== entry.base.valueJson)
      ) {
        const written = entry.fields;
        entry.fields = filledInWithin(entry, defaulted.get(entry.table));
        entry.filled = new Set(
          Object.keys(entry.fields).filter(
            (name) => !Object.hasOwn(written, name)
          )
        );
      }
    }
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
        // One more than the bound has room for is enough to refuse.
        .limit(cascadeJobMaxRecords - members.size + 2)
        .all();
      for (const { tableId, recordId } of referring) {
        // Left to the commit's own write (`#requireCascadeClosed`).
        const written = staged.get(keyOf(tableId, recordId));
        if (written !== undefined && written.fields !== null) {
          continue;
        }
        add({ tableId, recordId });
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
    { receiptId, principal, resourceId, runId, now }: CascadeStart
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
    const now = Date.now();
    const event: AuditEvent = auditEventSchema.parse({
      id: crypto.randomUUID(),
      at: new Date(now).toISOString(),
      source: "core",
      actor: { type: "person", userId: principal },
      action,
      target: { type: "store", id: this.#storeId() },
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
      const contract = this.#contractNow();
      this.files.index(
        deleted,
        job.principal,
        (table) => contract?.tables[table]?.fields,
        [],
        () => false
      );
      this.#cascadeBatchEvents(job, deleted);
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
   * contract declares them (`#contractNow`), not only the pinned table's:
   * a field a newer version wrote, which an older version's write keeps,
   * still refers, and the contract fixes each field's descriptor for good
   * (`defineTables` refuses changing one), so a record ID stays one.
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
    const contract = this.#contractNow();
    let storeTables: ReadonlyMap<string, string> | undefined;
    const tableIdOf = (name: string): string | undefined => {
      storeTables ??= new Map(
        this.#tableRows().map((row) => [row.name, row.tableId])
      );
      return storeTables.get(name);
    };
    for (const { table, tableId, recordId, base, fields, filled } of staged) {
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
      const declared = (contract ?? pinned.manifest).tables[table]?.fields;
      if (fields === null || declared === undefined) {
        continue;
      }
      // A reference the store filled in itself, from a default approved
      // with its schema, need only name a record that exists: its writer
      // never sent it, so whether that writer may read the record says
      // nothing of it.
      const own = Object.fromEntries(
        Object.entries(declared).filter(([name]) => filled?.has(name) !== true)
      );
      const defaults = Object.fromEntries(
        Object.entries(declared).filter(([name]) => filled?.has(name) === true)
      );
      const references = [
        ...recordReferences(own, fields).map((found) => ({
          found,
          read: true,
        })),
        ...recordReferences(defaults, fields).map((found) => ({
          found,
          read: false,
        })),
      ];
      for (const { found: reference, read } of references) {
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
              (read
                ? this.#referable(pinned, byKey, principal, roles, target)
                : this.#ownerAfter(byKey, principal, target) !== undefined));
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
   * The store's contract as its row holds it now (call it inside a
   * transaction), or undefined while it has none. Read again only when its
   * hash moved on; its hash was checked when it was set (`defineTables`).
   */
  #contractNow(): SchemaManifest | undefined {
    const row = this.#db
      .select({
        hash: store.contractHash,
        manifest: store.contractManifest,
      })
      .from(store)
      .get();
    if (
      row?.hash === null ||
      row?.hash === undefined ||
      row.manifest === null
    ) {
      return undefined;
    }
    if (this.#contract?.hash !== row.hash) {
      this.#contract = {
        hash: row.hash,
        manifest: readSchemaManifest(row.manifest).manifest,
      };
    }
    return this.#contract.manifest;
  }

  /**
   * Whether record `target` exists once the commit's `staged` records are
   * written, and `principal` with `roles` may read it under the pinned
   * schema's access: its table's read mode admits them, and for an
   * `owner` table, the record is theirs (one this commit inserts is).
   */
  #referable(
    pinned: PinnedSchema,
    staged: ReadonlyMap<string, Staged>,
    principal: string,
    roles: WriterRoles,
    target: { table: string; tableId: string; recordId: string }
  ): boolean {
    const mode = Object.hasOwn(pinned.manifest.tables, target.table)
      ? pinned.manifest.tables[target.table]?.access.read
      : undefined;
    const admitted =
      mode === "owner" ||
      (mode === "appMembers" && (roles.appMember || roles.appBuilder)) ||
      (mode === "appBuilders" && roles.appBuilder);
    if (!admitted) {
      return false;
    }
    const owner = this.#ownerAfter(staged, principal, target);
    return owner !== undefined && (mode !== "owner" || owner === principal);
  }

  /**
   * The owner of record `target` once the commit's `staged` records are
   * written, or undefined when it doesn't exist then.
   */
  #ownerAfter(
    staged: ReadonlyMap<string, Staged>,
    principal: string,
    target: { tableId: string; recordId: string }
  ): string | undefined {
    const entry = staged.get(keyOf(target.tableId, target.recordId));
    if (entry === undefined) {
      return this.#db
        .select({ owner: records.ownerId })
        .from(records)
        .where(
          and(
            eq(records.tableId, target.tableId),
            eq(records.recordId, target.recordId)
          )
        )
        .get()?.owner;
    }
    return entry.fields === null
      ? undefined
      : (entry.base?.ownerId ?? principal);
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
    // While an explicit migration is pending or ready, every record of a
    // table it migrates that this commit inserts or changes under another
    // schema than its target is queued for its transform, in this
    // transaction (store-migrations.ts): a record transformed already and
    // then edited by the version still current must be transformed again
    // from the edit, whether or not it still fits the target.
    const migrating = this.#migrating();
    for (const { table, tableId, recordId, base, fields } of staged) {
      const written =
        fields !== null &&
        (base === undefined || storedText(fields) !== base.valueJson);
      if (
        migrating !== null &&
        migrating.tables.has(table) &&
        schemaHash !== migrating.schema &&
        written
      ) {
        queueWork(
          this.#db,
          migrating.target,
          tableId,
          { recordId, ownerId: base?.ownerId ?? ownerId },
          now
        );
        // A ready migration has work again: no longer ready, its run is
        // taken up again (store-backfill.ts, `keepStoreBackfillGoing`).
        this.#db
          .update(backfills)
          .set({ readyAt: null })
          .where(eq(backfills.targetHash, migrating.target))
          .run();
      }
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
   * A sample of the records `migration` of `consumer`'s release still has
   * to transform in `table`, at most `limit`, for its dry run
   * (migration-samples.ts, `sampleRows`): from where its pending target's
   * backfill stands, read in a transaction that writes nothing, so
   * neither a record nor the backfill moves. Empty when no change is
   * pending (its migration done); `migration.not_pending` when another
   * release's is.
   */
  sampleMigration(
    storeId: StoreId,
    sample: {
      table: string;
      migration: string;
      consumer: { resourceId: string; resourceVersion: number };
      limit: number;
    }
  ): MigrationRow[] {
    const { table, migration, consumer, limit } = dataErrors.parse(
      "data.invalid",
      migrationSampleSchema,
      sample
    );
    return this.ctx.storage.transactionSync(() => {
      this.#bind(storeId, false);
      const pending = this.#pendingTarget();
      if (pending === null) {
        return [];
      }
      // Another release's change is pending here: this one's migration
      // hasn't run, so "nothing left" would be false.
      const [resourceId, resourceVersion] = pending.migrations?.consumer ?? [];
      if (
        resourceId !== consumer.resourceId ||
        resourceVersion !== consumer.resourceVersion
      ) {
        throw migrationErrors.create("migration.not_pending");
      }
      const migrated = this.#migratedTables(pending).find(
        (found) => found.table === table && found.migration === migration
      );
      const row = this.#db
        .select()
        .from(backfills)
        .where(eq(backfills.targetHash, pending.hash))
        .get();
      if (migrated === undefined || row === undefined) {
        return [];
      }
      const cursor =
        row.phase !== "scan" ||
        row.cursorTable === null ||
        row.cursorRecord === null ||
        row.cursorOwner === null ||
        row.cursorCreatedAt === null
          ? null
          : {
              tableId: row.cursorTable,
              ownerId: row.cursorOwner,
              createdAt: row.cursorCreatedAt,
              recordId: row.cursorRecord,
            };
      return sampleRows(
        this.#db,
        migrated,
        pending.hash,
        scanOf(migrated, row.phase, cursor),
        limit
      );
    });
  }

  /**
   * Why the backfill of `consumer`'s pending migration would refuse one
   * of a dry run's `outputs` (migration-samples.ts), as it refuses a
   * batch's (`#checkedWrites`): an output that doesn't fit the target or
   * the contract in force, changes a field that refers to records, or is
   * too large; null when it would write them all. Read in a transaction
   * that writes nothing. A record gone or edited since it was sampled is
   * skipped, as a batch drops or queues it.
   */
  checkSampleOutputs(
    storeId: StoreId,
    sample: unknown
  ): (Pick<MigrationFailure, "reason" | "issues"> & { id: string }) | null {
    const { table, migration, consumer, outputs } = dataErrors.parse(
      "data.invalid",
      sampleOutputsSchema,
      sample
    );
    return this.ctx.storage.transactionSync(() => {
      this.#bind(storeId, false);
      const pending = this.#pendingTarget();
      const [resourceId, resourceVersion] = pending?.migrations?.consumer ?? [];
      if (
        pending === null ||
        resourceId !== consumer.resourceId ||
        resourceVersion !== consumer.resourceVersion
      ) {
        throw migrationErrors.create("migration.not_pending");
      }
      const migrated = this.#migratedTables(pending).find(
        (found) => found.table === table && found.migration === migration
      );
      const contract = this.#contractNow();
      if (migrated === undefined || contract === undefined) {
        throw migrationErrors.create("migration.metadata_corrupt");
      }
      const targetFields = tableFieldsOf(pending.manifest, table);
      const contractFields = tableFieldsOf(contract, table);
      for (const output of outputs) {
        const record = this.#db
          .select()
          .from(records)
          .where(
            and(
              eq(records.tableId, migrated.tableId),
              eq(records.recordId, output.id)
            )
          )
          .get();
        // Gone, or edited since it was sampled: a batch drops or queues
        // it rather than judge an output of what it no longer holds.
        if (record === undefined || record.revision !== output.revision) {
          continue;
        }
        const refusal =
          outputRefusal(
            targetFields,
            contractFields,
            fieldsOf(record),
            output.fields
          ) ??
          (encoder.encode(storedText(output.fields)).byteLength >
          documentMaxBytes
            ? {
                reason: "too_large" as const,
                issues: [`A record holds at most ${documentMaxBytes} bytes`],
              }
            : undefined);
        if (refusal !== undefined) {
          return { id: output.id, ...refusal };
        }
      }
      return null;
    });
  }

  /**
   * Runs batch `batch` of the backfill of the pending target `target`
   * for its run `attempt` (spec 17.2, 17.4 step 5): in one transaction,
   * the next records after the backfill's cursor, at most
   * `backfillBatchSize`, table after table of those it fills, in the
   * order of their IDs. Each record gets the defaulted fields it lacks
   * (store-fills.ts), which moves its revision on (and its table's
   * generation), as any change of its document does; a record that holds
   * a field keeps its value when it is valid, and fails the backfill
   * (`state: "failed"`, naming the record) when it isn't, or when filling
   * it in would make its document too large: never overwritten. The
   * cursor, the counts and the batch's outcome commit with the records.
   *
   * The batch that finds no record left activates the target in the
   * same transaction: compares and sets the store's contract against the
   * one the target was planned from, and marks the backfill complete, its
   * activation receipt. Records written meanwhile need no second look:
   * every commit since the target became pending filled in what it wrote
   * (`#flush`), whatever schema its writer was pinned to.
   *
   * Retried with the same batch (an answer that was lost), it answers the
   * outcome it committed and does nothing; a batch other than the next,
   * or a run the store moved past (`restartBackfill`), is refused
   * (`migration.superseded`), and so is a target the store doesn't hold.
   * A complete backfill answers complete to any run. Each batch renews
   * the run's lease.
   */
  fillMissing(
    storeId: StoreId,
    step: BackfillStep
  ): BackfillOutcome | MigrationBatch {
    const { target, attempt, batch } = dataErrors.parse(
      "data.invalid",
      backfillStepSchema,
      step
    );
    const answered = this.ctx.storage.transactionSync(
      (): BackfillOutcome | MigrationBatch => {
        this.#bind(storeId, false);
        const row = this.#db
          .select()
          .from(backfills)
          .where(eq(backfills.targetHash, target))
          .get();
        if (row === undefined) {
          throw migrationErrors.create("migration.superseded");
        }
        if (row.state === "complete") {
          return {
            state: "complete",
            batch,
            scanned: row.scanned,
            filled: row.filled,
            failure: null,
          };
        }
        if (row.attempt !== attempt) {
          throw migrationErrors.create("migration.superseded");
        }
        if (row.lastOutcome !== null && batch === row.lastBatch) {
          return outcomeSchema.parse(JSON.parse(row.lastOutcome));
        }
        if (row.state === "failed" || batch !== row.lastBatch + 1) {
          throw migrationErrors.create("migration.superseded");
        }
        const pending = this.#pendingTarget();
        if (pending?.hash !== target) {
          throw new Error("A running backfill isn't the pending target");
        }
        if (pending.migrations !== null) {
          return this.#migrationBatch(pending, row, batch, Date.now());
        }
        return this.#fillBatch(pending, row, batch, Date.now());
      }
    );
    if (answered.state === "complete") {
      // A migration's activation may have left schemas behind: nothing
      // pinned to one is kept from before it.
      this.#schemasGeneration += 1;
      this.#schemas.clear();
    }
    return answered;
  }

  /**
   * The migrated tables of `pending`, by table ID, as its batches go
   * through them (store-migrations.ts).
   */
  #migratedTables(pending: PendingTarget): MigratedTable[] {
    const ids = new Map(
      this.#tableRows().map(({ name, tableId }) => [name, tableId])
    );
    return (pending.migrations?.migrations ?? [])
      .map(([table, migration]): MigratedTable => {
        const tableId = ids.get(table);
        const access = pending.manifest.tables[table]?.access;
        if (tableId === undefined || access === undefined) {
          throw migrationErrors.create("migration.metadata_corrupt");
        }
        return {
          table,
          tableId,
          migration,
          owned: access.read === "owner" || access.write === "owner",
          bound: pending.scanBounds[tableId] ?? "",
        };
      })
      .toSorted((a, b) => (a.tableId < b.tableId ? -1 : 1));
  }

  /**
   * `fillMissing`'s batch of an explicit migration, in its transaction:
   * the next records to transform, scan first, then queued work, for core
   * to transform and commit (`commitTransformed`); or, once neither has
   * any left, the target activated, as a fill's last batch does.
   */
  #migrationBatch(
    pending: PendingTarget,
    row: typeof backfills.$inferSelect,
    batch: number,
    now: number
  ): BackfillOutcome | MigrationBatch {
    const migrated = this.#migratedTables(pending);
    const [resourceId = "", resourceVersion = 1] =
      pending.migrations?.consumer ?? [];
    const consumer = { resourceId, resourceVersion };
    if (row.phase === "scan") {
      const cursor =
        row.cursorTable === null ||
        row.cursorRecord === null ||
        row.cursorOwner === null ||
        row.cursorCreatedAt === null
          ? null
          : {
              tableId: row.cursorTable,
              ownerId: row.cursorOwner,
              createdAt: row.cursorCreatedAt,
              recordId: row.cursorRecord,
            };
      const scanned = nextScanBatch(this.#db, migrated, cursor);
      if (scanned !== null) {
        return {
          state: "transform",
          batch,
          phase: "scan",
          table: scanned.table.table,
          migration: scanned.table.migration,
          consumer,
          rows: scanned.rows,
          through: scanned.through,
        };
      }
      this.#db
        .update(backfills)
        .set({
          phase: "work",
          cursorTable: null,
          cursorRecord: null,
          cursorOwner: null,
          cursorCreatedAt: null,
        })
        .where(eq(backfills.targetHash, pending.hash))
        .run();
    }
    const work = nextWorkBatch(this.#db, pending.hash, migrated);
    if (work !== null) {
      return {
        state: "transform",
        batch,
        phase: "work",
        table: work.table.table,
        migration: work.table.migration,
        consumer,
        rows: work.rows,
        through: null,
      };
    }
    // Scan through and no work left, in this transaction: no record of a
    // migrated table fails to fit the target. It is ready, and takes over
    // as a release sealed on it is made current (`activateReady`), so the
    // version still current goes on writing until then; its run ends.
    const outcome: BackfillOutcome = {
      state: "ready",
      batch,
      scanned: row.scanned,
      filled: row.filled,
      failure: null,
    };
    this.#db
      .update(backfills)
      .set({
        readyAt: pending.readyAt ?? now,
        // Done, not stalled: runs taken up again for work a write queued
        // count stalls afresh from here.
        stalls: 0,
        stallScanned: row.scanned,
        lastBatch: batch,
        lastOutcome: JSON.stringify(outcome),
        leaseUntil: null,
      })
      .where(eq(backfills.targetHash, pending.hash))
      .run();
    return outcome;
  }

  /**
   * Activates the pending target as a release whose schema
   * (`schemaHash`) it holds is made current for `consumer` (core,
   * store-backfill.ts, `requireStoreSchemaActive`), when it is an explicit
   * migration found ready: checked again in this transaction, so work a
   * write queued since puts it back to running instead (its run goes on,
   * kept going as any). Activation is `#activate`'s: the contract moves to
   * the target, and the schemas it no longer fits are left behind. Answers
   * the schema's status after (`schemaStatus`).
   */
  activateReady(
    storeId: StoreId,
    schemaHash: string,
    consumer: SchemaConsumer
  ): SchemaStatus {
    const hash = dataErrors.parse(
      "data.invalid",
      backfillTargetSchema,
      schemaHash
    );
    const activated = this.ctx.storage.transactionSync((): boolean => {
      this.#bind(storeId, false);
      const pending = this.#pendingTarget();
      const recorded = this.#db
        .select({ manifest: schemas.manifest })
        .from(schemas)
        .where(eq(schemas.schemaHash, hash))
        .get();
      if (
        pending?.migrations === null ||
        pending?.migrations === undefined ||
        pending.readyAt === null ||
        pending.state !== "running" ||
        recorded === undefined ||
        !covered(
          planSchemaChange(
            pending.manifest,
            readSchemaManifest(recorded.manifest).manifest
          )
        )
      ) {
        return false;
      }
      if (hasWork(this.#db, pending.hash)) {
        this.#db
          .update(backfills)
          .set({ readyAt: null })
          .where(eq(backfills.targetHash, pending.hash))
          .run();
        return false;
      }
      this.#activate(pending);
      this.#db
        .update(backfills)
        .set({ state: "complete", completedAt: Date.now() })
        .where(eq(backfills.targetHash, pending.hash))
        .run();
      return true;
    });
    if (activated) {
      this.#schemasGeneration += 1;
      this.#schemas.clear();
    }
    return this.schemaStatus(storeId, hash, consumer);
  }

  /**
   * Commits batch `batch` of the explicit migration of the pending target
   * `target`, which core transformed (store-backfill.ts) from what
   * `fillMissing` handed it, for run `attempt`, in one transaction under
   * the same fence, numbering and receipt as a fill's batch: a batch
   * committed already is answered from its receipt, never compared with
   * this one (a transform run again may answer otherwise); one from a run
   * the store moved past, or not the next, is `migration.superseded`.
   *
   * Each record commits only at the revision it was read at; one that
   * moved on (a concurrent edit) is queued and transformed again from its
   * new revision, never overwritten; one that's gone is skipped. Each
   * output must fit the target table and the contract in force, and keep
   * every field that can refer to a record as it was
   * (store-migrations.ts, `outputRefusal`): otherwise the backfill fails
   * on that record, writing nothing of the batch, as it does with the
   * `failure` core found. A scan batch moves the cursor to `through`; a
   * work batch drops the work it did.
   */
  commitTransformed(
    storeId: StoreId,
    input: TransformedBatch
  ): BackfillOutcome {
    const parsed = dataErrors.parse("data.invalid", transformedSchema, input);
    const { target, attempt, batch } = parsed;
    return this.ctx.storage.transactionSync((): BackfillOutcome => {
      this.#bind(storeId, false);
      const row = this.#db
        .select()
        .from(backfills)
        .where(eq(backfills.targetHash, target))
        .get();
      if (row === undefined) {
        throw migrationErrors.create("migration.superseded");
      }
      if (row.state === "complete") {
        return {
          state: "complete",
          batch,
          scanned: row.scanned,
          filled: row.filled,
          failure: null,
        };
      }
      if (row.attempt !== attempt) {
        throw migrationErrors.create("migration.superseded");
      }
      if (row.lastOutcome !== null && batch === row.lastBatch) {
        return outcomeSchema.parse(JSON.parse(row.lastOutcome));
      }
      if (row.state === "failed" || batch !== row.lastBatch + 1) {
        throw migrationErrors.create("migration.superseded");
      }
      const pending = this.#pendingTarget();
      if (pending?.hash !== target || pending.migrations === null) {
        throw new Error("A migration's batch isn't for the pending target");
      }
      return this.#commitBatch(pending, row, parsed, Date.now());
    });
  }

  /** `commitTransformed`'s writes, in its transaction. */
  #commitBatch(
    pending: PendingTarget,
    row: typeof backfills.$inferSelect,
    input: z.output<typeof transformedSchema>,
    now: number
  ): BackfillOutcome {
    const table = this.#migratedTables(pending).find(
      ({ table: name }) => name === input.table
    );
    if (
      table === undefined ||
      (input.phase === "scan") !== (input.through !== null)
    ) {
      throw new Error("A migration's batch doesn't fit where it is");
    }
    const reported = this.#currentFailure(pending.hash, table, row, input, now);
    if (reported === undefined) {
      this.#requireCovered(pending.hash, table, row, input);
    }
    const checked =
      reported === undefined
        ? this.#checkedWrites(pending, table, input.rows, now)
        : { writes: [], failure: { ...reported } };
    const { failure } = checked;
    const changed = checked.writes.filter(
      ({ record, valueJson }) => valueJson !== record.valueJson
    );
    if (failure === null) {
      this.#writeTransformed(pending.hash, table.tableId, checked.writes);
    }
    const outcome: BackfillOutcome = {
      state: failure === null ? "running" : "failed",
      batch: input.batch,
      scanned: row.scanned + (failure === null ? input.rows.length : 0),
      filled: row.filled + (failure === null ? changed.length : 0),
      failure,
    };
    this.#recordBatch(pending.hash, table.tableId, outcome, {
      through: failure === null ? input.through : null,
      now,
    });
    return outcome;
  }

  /**
   * The failure core reported for a batch, if it still holds: one on a
   * record that changed since the batch read it (`failureRevision`, the
   * revision the transform saw) was the transform of a value no longer
   * there. It is dropped, and every record the batch handed out queued as
   * work, transformed again from what it holds now; so a record mended
   * while its transform failed is retried without another edit.
   */
  #currentFailure(
    target: string,
    table: MigratedTable,
    row: typeof backfills.$inferSelect,
    input: z.output<typeof transformedSchema>,
    now: number
  ): MigrationFailure | undefined {
    const { failure, failureRevision } = input;
    if (
      failure === undefined ||
      failure.id === null ||
      failureRevision === undefined
    ) {
      return failure;
    }
    const record = this.#db
      .select({ revision: records.revision })
      .from(records)
      .where(
        and(
          eq(records.tableId, table.tableId),
          eq(records.recordId, failure.id)
        )
      )
      .get();
    if (record?.revision === failureRevision) {
      return failure;
    }
    if (input.through !== null) {
      for (const id of scanRangeIds(
        this.#db,
        table,
        cursorOf(row),
        input.through
      )) {
        const handed = this.#db
          .select()
          .from(records)
          .where(
            and(eq(records.tableId, table.tableId), eq(records.recordId, id))
          )
          .get();
        if (handed !== undefined) {
          queueWork(this.#db, target, table.tableId, handed, now);
        }
      }
    }
    return undefined;
  }

  /**
   * Refuses, as a caller's bug, a batch that doesn't account for exactly
   * the records the store handed out for it: a scan batch every record
   * from the cursor through `through` (each committed, or queued as work
   * since), none outside it; a work batch only queued records.
   */
  #requireCovered(
    target: string,
    table: MigratedTable,
    row: typeof backfills.$inferSelect,
    input: z.output<typeof transformedSchema>
  ): void {
    const ids = new Set(input.rows.map(({ id }) => id));
    if (input.through === null) {
      if (
        input.rows.some(
          ({ id }) => !isQueued(this.#db, target, table.tableId, id)
        )
      ) {
        throw new Error("A migration's work batch names records not queued");
      }
      return;
    }
    if (input.through.tableId !== table.tableId) {
      throw new Error("A migration's scan batch ends in another table");
    }
    const range = new Set(
      scanRangeIds(this.#db, table, cursorOf(row), input.through)
    );
    const outside = [...ids].some(
      (id) =>
        !range.has(id) &&
        this.#db
          .select({ id: records.recordId })
          .from(records)
          .where(
            and(eq(records.tableId, table.tableId), eq(records.recordId, id))
          )
          .get() !== undefined
    );
    const missed = [...range].some(
      (id) => !ids.has(id) && !isQueued(this.#db, target, table.tableId, id)
    );
    if (outside || missed) {
      throw new Error(
        "A migration's scan batch doesn't cover exactly the records handed out"
      );
    }
  }

  /**
   * The writes a migration's batch makes, each record at the revision it
   * was read at and its output refused or not (`commitTransformed`), or
   * the failure that writes none of them. Queues a record edited since
   * it was read, and drops the work of one that's gone.
   */
  #checkedWrites(
    pending: PendingTarget,
    table: MigratedTable,
    rows: z.output<typeof transformedSchema>["rows"],
    now: number
  ): {
    writes: { record: typeof records.$inferSelect; valueJson: string }[];
    failure: MigrationFailure | null;
  } {
    const contract = this.#contractNow();
    if (contract === undefined) {
      throw migrationErrors.create("migration.metadata_corrupt");
    }
    const targetFields = tableFieldsOf(pending.manifest, table.table);
    const contractFields = tableFieldsOf(contract, table.table);
    const writes: { record: typeof records.$inferSelect; valueJson: string }[] =
      [];
    for (const transformed of rows) {
      const record = this.#db
        .select()
        .from(records)
        .where(
          and(
            eq(records.tableId, table.tableId),
            eq(records.recordId, transformed.id)
          )
        )
        .get();
      if (record === undefined) {
        dropWork(this.#db, pending.hash, table.tableId, transformed.id);
      } else if (record.revision === transformed.revision) {
        const valueJson = storedText(transformed.fields);
        const refusal =
          outputRefusal(
            targetFields,
            contractFields,
            fieldsOf(record),
            transformed.fields
          ) ??
          (encoder.encode(valueJson).byteLength > documentMaxBytes
            ? {
                reason: "too_large" as const,
                issues: [`A record holds at most ${documentMaxBytes} bytes`],
              }
            : undefined);
        if (refusal !== undefined) {
          return {
            writes: [],
            failure: {
              table: table.table,
              id: record.recordId,
              migration: table.migration,
              ...refusal,
            },
          };
        }
        writes.push({ record, valueJson });
      } else {
        // Edited since it was read: transformed again from its new
        // revision, never overwritten with what the old one became.
        queueWork(this.#db, pending.hash, table.tableId, record, now);
      }
    }
    return { writes, failure: null };
  }

  /**
   * Writes a migration batch's checked records, dropping their work.
   *
   * The files a record holds (`sdk_file_refs`, file-host.ts) aren't indexed
   * again here, by decision (GRA-256): they are kept per record, so a
   * transform moving a file between fields keeps it held, and one dropping
   * a file leaves it held, so kept and readable through the record, until
   * the record is next written by a commit or deleted. That errs towards
   * keeping a file, never towards losing one a record still shows.
   */
  #writeTransformed(
    target: string,
    tableId: string,
    writes: readonly {
      record: typeof records.$inferSelect;
      valueJson: string;
    }[]
  ): void {
    let wrote = false;
    for (const { record, valueJson } of writes) {
      if (valueJson !== record.valueJson) {
        // Its revision moves on, as for any change of its document; its
        // update time stays the last time someone edited it.
        this.#db
          .update(records)
          .set({ revision: record.revision + 1, valueJson })
          .where(
            and(
              eq(records.tableId, record.tableId),
              eq(records.recordId, record.recordId),
              eq(records.revision, record.revision)
            )
          )
          .run();
        wrote = true;
      }
      dropWork(this.#db, target, tableId, record.recordId);
    }
    if (wrote) {
      this.#db
        .update(tables)
        .set({ generation: sql`${tables.generation} + 1` })
        .where(eq(tables.tableId, tableId))
        .run();
      this.#moved([tableId]);
    }
  }

  /**
   * A migration batch's outcome, as its receipt, with the cursor moved to
   * `through` (a scan batch's) and, for a failure, the revision of the
   * record that failed it, which a retry waits to see move on.
   */
  #recordBatch(
    target: string,
    tableId: string,
    outcome: BackfillOutcome,
    { through, now }: { through: ScanPosition | null; now: number }
  ): void {
    const { failure } = outcome;
    const failedId =
      failure !== null && "migration" in failure ? failure.id : null;
    const failedAt =
      failedId === null
        ? undefined
        : this.#db
            .select({ revision: records.revision })
            .from(records)
            .where(
              and(eq(records.tableId, tableId), eq(records.recordId, failedId))
            )
            .get();
    const cursor =
      through === null
        ? {}
        : {
            cursorTable: through.tableId,
            cursorOwner: through.ownerId,
            cursorCreatedAt: through.createdAt,
            cursorRecord: through.recordId,
          };
    this.#db
      .update(backfills)
      .set({
        state: failure === null ? "running" : "failed",
        lastBatch: outcome.batch,
        lastOutcome: JSON.stringify(outcome),
        scanned: outcome.scanned,
        filled: outcome.filled,
        failure: failure === null ? null : JSON.stringify(failure),
        failureRevision: failedAt?.revision ?? null,
        leaseUntil: failure === null ? now + backfillLeaseMs : null,
        ...cursor,
      })
      .where(eq(backfills.targetHash, target))
      .run();
  }

  /** `fillMissing`'s batch, in its transaction. */
  #fillBatch(
    pending: PendingTarget,
    row: typeof backfills.$inferSelect,
    batch: number,
    now: number
  ): BackfillOutcome {
    const scan = this.#fillPlan(pending);
    const order = [...scan.keys()].toSorted();
    const start = row.cursorTable === null ? 0 : order.indexOf(row.cursorTable);
    if (start < 0) {
      throw migrationErrors.create("migration.metadata_corrupt");
    }
    const { index, after, scanned, filled, failure, changed } = this.#scan(
      scan,
      order,
      { index: start, after: row.cursorRecord ?? "" }
    );
    if (changed.size > 0) {
      this.#db
        .update(tables)
        .set({ generation: sql`${tables.generation} + 1` })
        .where(inArray(tables.tableId, [...changed]))
        .run();
      this.#moved(changed);
    }
    const done = failure === null && index >= order.length;
    let state: BackfillOutcome["state"] = "running";
    if (failure !== null) {
      state = "failed";
    } else if (done) {
      state = "complete";
    }
    const outcome: BackfillOutcome = {
      state,
      batch,
      scanned: row.scanned + scanned,
      filled: row.filled + filled,
      failure,
    };
    if (done) {
      this.#activate(pending);
    }
    const failed =
      failure === null
        ? undefined
        : this.#db
            .select({ revision: records.revision })
            .from(records)
            .where(
              and(
                eq(records.tableId, order[index] ?? ""),
                eq(records.recordId, failure.id)
              )
            )
            .get();
    this.#db
      .update(backfills)
      .set({
        state,
        lastBatch: batch,
        failureRevision: failed?.revision ?? null,
        lastOutcome: JSON.stringify(outcome),
        cursorTable: done ? null : (order[index] ?? null),
        cursorRecord: done ? null : after,
        scanned: outcome.scanned,
        filled: outcome.filled,
        failure: failure === null ? null : JSON.stringify(failure),
        leaseUntil: state === "running" ? now + backfillLeaseMs : null,
        completedAt: done ? now : null,
      })
      .where(eq(backfills.targetHash, pending.hash))
      .run();
    return outcome;
  }

  /**
   * The records one batch looks at, from the cursor (`index` into
   * `order`, the tables to scan, and the record `after` which it goes
   * on), filled in where they need it: until `backfillBatchSize` were
   * looked at, every table was, or one failed. Where the cursor is then,
   * what it did, and which tables' records it changed.
   */
  #scan(
    scan: ReadonlyMap<
      string,
      { table: string; fields: DefaultedField[]; bound: string }
    >,
    order: readonly string[],
    cursor: { index: number; after: string }
  ): {
    index: number;
    after: string;
    scanned: number;
    filled: number;
    failure: RecordFailure | null;
    changed: Set<string>;
  } {
    let { index, after } = cursor;
    let scanned = 0;
    let filled = 0;
    const changed = new Set<string>();
    while (index < order.length && scanned < backfillBatchSize) {
      const tableId = order[index] ?? "";
      const {
        table,
        fields: toFill,
        bound,
      } = scan.get(tableId) ?? { table: "", fields: [], bound: "" };
      const wanted = backfillBatchSize - scanned;
      const rows = this.#db
        .select()
        .from(records)
        .where(
          and(
            eq(records.tableId, tableId),
            gt(records.recordId, after),
            lte(records.recordId, bound)
          )
        )
        .orderBy(asc(records.recordId))
        .limit(wanted)
        .all();
      for (const record of rows) {
        const result = this.#fillRecord(table, toFill, record);
        if (typeof result !== "boolean") {
          return { index, after, scanned, filled, failure: result, changed };
        }
        if (result) {
          filled += 1;
          changed.add(tableId);
        }
        scanned += 1;
        after = record.recordId;
      }
      if (rows.length < wanted) {
        index += 1;
        after = "";
      }
    }
    return { index, after, scanned, filled, failure: null, changed };
  }

  /**
   * Fills in `toFill` where `record` (of `table`) lacks them, writing it
   * back when that changed it: whether it did. The failure, writing
   * nothing, when it holds one of them with a value the field doesn't
   * accept, or filling in would make it too large.
   */
  #fillRecord(
    table: string,
    toFill: readonly DefaultedField[],
    record: typeof records.$inferSelect
  ): RecordFailure | boolean {
    const stored = fieldsOf(record);
    const invalid = toFill.find(
      ({ field, descriptor }) =>
        Object.hasOwn(stored, field) && !validates(descriptor, stored[field])
    );
    if (invalid !== undefined) {
      return {
        table,
        field: invalid.field,
        id: record.recordId,
        reason: "invalid_value",
      };
    }
    const next = filledIn(stored, toFill);
    if (next === stored) {
      return false;
    }
    const valueJson = storedText(next);
    if (encoder.encode(valueJson).byteLength > documentMaxBytes) {
      return {
        table,
        field:
          toFill.find(({ field }) => !Object.hasOwn(stored, field))?.field ??
          "",
        id: record.recordId,
        reason: "too_large",
      };
    }
    // Its revision moves on, as for any change of its document, so a
    // write that read it before is a conflict, never a lost fill; its
    // update time stays the last time someone edited it.
    this.#db
      .update(records)
      .set({ revision: record.revision + 1, valueJson })
      .where(
        and(
          eq(records.tableId, record.tableId),
          eq(records.recordId, record.recordId)
        )
      )
      .run();
    return true;
  }

  /**
   * The tables the backfill of `pending` scans, by ID, each with its
   * name, the defaulted fields it fills there and the record its scan
   * ends at; a table that held no record when the target became pending
   * is left out.
   */
  #fillPlan(
    pending: PendingTarget
  ): Map<string, { table: string; fields: DefaultedField[]; bound: string }> {
    const tableIds = new Map(
      this.#tableRows().map(({ name, tableId }) => [name, tableId])
    );
    const defaulted = defaultedFieldsOf(pending.manifest);
    const scan = new Map<
      string,
      { table: string; fields: DefaultedField[]; bound: string }
    >();
    for (const { table, field } of pending.fills) {
      const tableId = tableIds.get(table);
      const fill = defaulted.get(table)?.find((one) => one.field === field);
      if (tableId === undefined || fill === undefined) {
        throw migrationErrors.create("migration.metadata_corrupt");
      }
      const bound = pending.scanBounds[tableId];
      if (bound === undefined) {
        continue;
      }
      const entry = scan.get(tableId) ?? { table, fields: [], bound };
      entry.fields.push(fill);
      scan.set(tableId, entry);
    }
    return scan;
  }

  /**
   * Moves the store's contract to `pending`, compared and set against
   * the contract it was planned from, in the transaction that finds its
   * backfill complete. Nothing else moves the contract while a target is
   * pending (`defineTables`), so a contract that moved is the store's own
   * records disagreeing: refused, never activated over.
   */
  #activate(pending: PendingTarget): void {
    const moved = this.#db
      .update(store)
      .set({
        contractHash: pending.hash,
        contractManifest: manifestText(pending.manifest),
      })
      .where(
        pending.baseHash === null
          ? isNull(store.contractHash)
          : eq(store.contractHash, pending.baseHash)
      )
      .returning({ hash: store.contractHash })
      .get();
    if (moved === undefined) {
      throw migrationErrors.create("migration.metadata_corrupt");
    }
    if (pending.migrations !== null) {
      this.#supersede(pending.manifest, Date.now());
      this.#db
        .delete(migrationWork)
        .where(eq(migrationWork.targetHash, pending.hash))
        .run();
    }
  }

  /**
   * Lets a new run of the backfill of `target` take over from run
   * `attempt`, which its engine says ended without finishing it: moves
   * the fence on, so nothing run `attempt` still sends is answered, and
   * starts the new run's batches from 1 at the cursor where the last one
   * left. Refused while run `attempt`'s lease still holds
   * (`migration.busy`, retryable), unless run `attempt` itself hands
   * over as it ends (`ending`, a run that took its share of batches).
   * Answers the run the store now answers; one already moved past
   * `attempt`, or a backfill no longer running, is answered as it is,
   * changing nothing. A hand-over that finds the scan where the last one
   * found it, for the `backfillStallLimit`th time in a row, fails the
   * backfill as stalled instead, and answers `attempt` itself.
   */
  async restartBackfill(
    storeId: StoreId,
    restart: BackfillRestart
  ): Promise<number> {
    const { target, attempt, ending } = dataErrors.parse(
      "data.invalid",
      backfillRestartSchema,
      restart
    );
    const next = this.ctx.storage.transactionSync((): number => {
      this.#bind(storeId, false);
      const row = this.#db
        .select()
        .from(backfills)
        .where(eq(backfills.targetHash, target))
        .get();
      if (row === undefined) {
        throw migrationErrors.create("migration.superseded");
      }
      if (row.state !== "running" || row.attempt !== attempt) {
        return row.attempt;
      }
      const now = Date.now();
      if (ending !== true && row.leaseUntil !== null && row.leaseUntil > now) {
        throw migrationErrors.create("migration.busy", { retryable: true });
      }
      // A run that ended without moving the scan on, after others that
      // didn't either: a store error no retry mends. Stop handing over.
      const stalls =
        ending !== true && row.stallScanned === row.scanned
          ? row.stalls + 1
          : 0;
      if (stalls >= backfillStallLimit) {
        const failure: BackfillFailure = { reason: "stalled" };
        this.#db
          .update(backfills)
          .set({
            state: "failed",
            failure: JSON.stringify(failure),
            failureRevision: null,
            leaseUntil: null,
            stalls,
          })
          .where(eq(backfills.targetHash, target))
          .run();
        log.error("store.backfill_stalled", { target, attempt, stalls });
        return attempt;
      }
      this.#db
        .update(backfills)
        .set({
          attempt: attempt + 1,
          lastBatch: 0,
          lastOutcome: null,
          leaseUntil: null,
          lookedAt: now,
          stalls,
          stallScanned: row.scanned,
        })
        .where(eq(backfills.targetHash, target))
        .run();
      return attempt + 1;
    });
    // Set before core asks the engine for a run: should that fail, the
    // alarm still finds the backfill running (#keepBackfillGoing).
    await this.schedule();
    return next;
  }

  /**
   * The store's pending target and its backfill, by the target, whatever
   * schema brought it: what core drives a stalled or failed backfill from
   * (store-backfill.ts). Null when no target is pending.
   */
  backfillStatus(storeId: StoreId): BackfillStatus | null {
    return this.ctx.storage.transactionSync((): BackfillStatus | null => {
      this.#bind(storeId, false);
      const pending = this.#pendingTarget();
      return pending === null ? null : statusOf(pending);
    });
  }

  /**
   * Lets the failed backfill of `target` run again, from the record that
   * failed it, once that record changed since (its revision moved on, or
   * it was deleted): the fence moves on, and a new run continues at the
   * cursor. A failure nothing changed for stays failed, so retrying never
   * loops. Answers the backfill as it is then; null for a target no
   * longer pending.
   */
  async retryBackfill(
    storeId: StoreId,
    target: string
  ): Promise<BackfillStatus | null> {
    const hash = dataErrors.parse("data.invalid", backfillTargetSchema, target);
    const status = this.ctx.storage.transactionSync(
      (): BackfillStatus | null => {
        this.#bind(storeId, false);
        const pending = this.#pendingTarget();
        if (pending?.hash !== hash) {
          return null;
        }
        const { failure } = pending;
        if (pending.state !== "failed" || failure === null) {
          return statusOf(pending);
        }
        if ("migration" in failure && failure.id === null) {
          // The transform failed as a whole (its code, not a record):
          // nothing to watch change, so it stays failed until abandoned.
          return statusOf(pending);
        }
        if (failure.reason !== "stalled" && failure.reason !== "ready") {
          const tableId = this.#tableRows().find(
            ({ name }) => name === failure.table
          )?.tableId;
          const now = this.#db
            .select({ revision: records.revision })
            .from(records)
            .where(
              and(
                eq(records.tableId, tableId ?? ""),
                eq(records.recordId, failure.id ?? "")
              )
            )
            .get();
          if (now !== undefined && now.revision === pending.failureRevision) {
            return statusOf(pending);
          }
        }
        // A stalled backfill has no record to watch: each seal or
        // activation that asks retries it once, which is bounded by the
        // stall limit again (a builder's action, never the alarm's).
        const retried = this.#db
          .update(backfills)
          .set({
            state: "running",
            failure: null,
            failureRevision: null,
            attempt: pending.attempt + 1,
            lastBatch: 0,
            lastOutcome: null,
            leaseUntil: null,
            lookedAt: Date.now(),
            stalls: 0,
            stallScanned: null,
          })
          .where(eq(backfills.targetHash, hash))
          .returning()
          .get();
        if (retried === undefined) {
          throw new Error("A pending backfill went missing");
        }
        return statusOf({
          ...pending,
          state: "running",
          attempt: retried.attempt,
          lastBatch: 0,
          leaseUntil: null,
          failure: null,
          failureRevision: null,
        });
      }
    );
    // Set before core asks the engine for a run: should that fail, the
    // alarm still finds the backfill running (#keepBackfillGoing).
    await this.schedule();
    return status;
  }

  /**
   * Abandons the failed backfill of `target` for `actor`, an admin core
   * checked (store-abandon.ts), as of run `attempt`, the run the admin
   * saw fail: the pending target and its backfill row go, and the
   * contract stays as it was. In one transaction:
   *
   * - every field the target added over the contract is reserved with
   *   its descriptor (`sdk_reserved_fields`): records the backfill filled
   *   in keep the value, so a later schema may add the field again only
   *   as it was (`#planContract`);
   * - every recorded schema only the target held is marked abandoned, so
   *   the check of the contract against the store's schemas leaves it
   *   out until a later consumer applies it again;
   * - every consumer's receipt that waited on the target is marked
   *   abandoned: its release is refused as it is made current
   *   (`schemaStatus`), and applying its schema for it again is refused
   *   (`migration.abandoned`);
   * - the abandonment's record (`sdk_abandoned_targets`), which its audit
   *   event is made from.
   *
   * Refused for a backfill still running (`migration.not_failed`): it
   * either finishes or fails, and abandoning it would race its run. A
   * target no longer pending, or pending under another run than
   * `attempt` (a retry took it on), is `migration.superseded`, unless it
   * is this very abandonment, asked again: answered as recorded,
   * changing nothing, so core can repeat one whose audit didn't land.
   */
  async abandonBackfill(
    storeId: StoreId,
    abandon: BackfillAbandon,
    actor: AuditActor
  ): Promise<BackfillAbandonment> {
    const { target, attempt } = dataErrors.parse(
      "data.invalid",
      abandonSchema,
      abandon
    );
    const abandonedBy = JSON.stringify(auditActorSchema.parse(actor));
    // Checked as `defineTables` checks it, before the transaction, which
    // hashing can't run in; the transaction checks it is still the same.
    const row = this.#db
      .select({
        contractHash: store.contractHash,
        contractManifest: store.contractManifest,
      })
      .from(store)
      .get();
    const kept = row === undefined ? null : await contractOf(row);
    const abandoned = this.ctx.storage.transactionSync(
      (): BackfillAbandonment => {
        this.#bind(storeId, false);
        const pending = this.#pendingTarget();
        if (pending?.hash !== target || pending.attempt !== attempt) {
          const done = this.#db
            .select()
            .from(abandonedTargets)
            .where(
              and(
                eq(abandonedTargets.targetHash, target),
                eq(abandonedTargets.attempt, attempt)
              )
            )
            .get();
          if (done !== undefined) {
            return abandonmentOf(done);
          }
          throw migrationErrors.create("migration.superseded");
        }
        const ready = pending.state === "running" && pending.readyAt !== null;
        if (
          !ready &&
          (pending.state !== "failed" || pending.failure === null)
        ) {
          throw migrationErrors.create("migration.not_failed", {
            scanned: pending.scanned,
            filled: pending.filled,
          });
        }
        const now = this.#db
          .select({ hash: store.contractHash })
          .from(store)
          .get();
        if (
          kept === null ||
          now?.hash !== kept.hash ||
          pending.baseHash !== kept.hash
        ) {
          throw migrationErrors.create("migration.metadata_corrupt");
        }
        // A ready migration failed nothing: abandoned as it stands.
        return this.#abandon(
          pending,
          pending.failure ?? { reason: "ready" },
          kept.manifest,
          {
            abandonedBy,
            actor,
          }
        );
      }
    );
    this.#schemasGeneration += 1;
    this.#schemas.clear();
    await this.schedule();
    return abandoned;
  }

  /** `abandonBackfill`'s writes, in its transaction. */
  #abandon(
    pending: PendingTarget,
    failure: BackfillFailure,
    contract: SchemaManifest,
    { abandonedBy, actor }: { abandonedBy: string; actor: AuditActor }
  ): BackfillAbandonment {
    const at = Date.now();
    const plan = planSchemaChange(
      contract,
      pending.manifest,
      {},
      migratedSet(pending)
    );
    this.#db
      .delete(migrationWork)
      .where(eq(migrationWork.targetHash, pending.hash))
      .run();
    if (!plan.accepted) {
      throw migrationErrors.create("migration.metadata_corrupt");
    }
    // Every field the target added: to tables the contract has, and the
    // fields of tables it added (no record holds those, but a later
    // schema reusing their names with another meaning is refused alike).
    const added = [
      ...plan.addedFields,
      ...plan.addedTables.flatMap((table) =>
        Object.keys(pending.manifest.tables[table]?.fields ?? {}).map(
          (field) => ({ table, field })
        )
      ),
    ].toSorted(
      (a, b) => a.table.localeCompare(b.table) || a.field.localeCompare(b.field)
    );
    for (const { table, field } of added) {
      const descriptor: ValueDescriptor | undefined =
        pending.manifest.tables[table]?.fields[field];
      if (descriptor === undefined) {
        throw new Error("A planned field isn't in its target");
      }
      // Reserved once: a target planned under the reservation adds it
      // only as it was reserved.
      this.#db
        .insert(reservedFields)
        .values({
          tableName: table,
          fieldName: field,
          // As the canonical manifest it came from orders it.
          descriptor: JSON.stringify(descriptor),
          targetHash: pending.hash,
          reservedAt: at,
        })
        .onConflictDoNothing()
        .run();
    }
    const outOfForce = this.#db
      .select({ hash: schemas.schemaHash, manifest: schemas.manifest })
      .from(schemas)
      .where(isNull(schemas.abandonedAt))
      .orderBy(asc(schemas.schemaHash))
      .all()
      .filter(
        ({ manifest }) =>
          !covered(
            planSchemaChange(contract, readSchemaManifest(manifest).manifest)
          )
      )
      .map(({ hash }) => hash);
    if (outOfForce.length > 0) {
      this.#db
        .update(schemas)
        .set({ abandonedAt: at })
        .where(inArray(schemas.schemaHash, outOfForce))
        .run();
    }
    const consumers = this.#db
      .update(schemaActivations)
      .set({ abandonedAt: at })
      .where(
        and(
          eq(schemaActivations.contractHash, pending.hash),
          isNull(schemaActivations.abandonedAt)
        )
      )
      .returning({
        resourceId: schemaActivations.resourceId,
        resourceVersion: schemaActivations.resourceVersion,
      })
      .all()
      .toSorted(
        (a, b) =>
          a.resourceId.localeCompare(b.resourceId) ||
          a.resourceVersion - b.resourceVersion
      );
    this.#db
      .delete(backfills)
      .where(eq(backfills.targetHash, pending.hash))
      .run();
    const record = {
      baseHash: pending.baseHash,
      attempt: pending.attempt,
      scanned: pending.scanned,
      filled: pending.filled,
      failure: JSON.stringify(failure),
      schemas: canonicalJson(outOfForce),
      consumers: canonicalJson(
        consumers.map(({ resourceId, resourceVersion }) => [
          resourceId,
          resourceVersion,
        ])
      ),
      reserved: canonicalJson(added.map(({ table, field }) => [table, field])),
      abandonedBy,
      abandonedAt: at,
      auditedAt: null,
    };
    // One record per run: the same target abandoned again (added back as
    // it was, and failed again) goes on from a later run (`#makePending`),
    // so each abandonment keeps its own record and its own event.
    this.#db
      .insert(abandonedTargets)
      .values({ targetHash: pending.hash, ...record })
      .run();
    log.info("store.backfill_abandoned", {
      target: pending.hash,
      attempt: pending.attempt,
    });
    return {
      target: pending.hash,
      attempt: pending.attempt,
      scanned: pending.scanned,
      filled: pending.filled,
      failure,
      schemas: outOfForce,
      consumers,
      reserved: added.map(({ table, field }) => ({ table, field })),
      abandonedBy: actor,
      abandonedAt: at,
    };
  }

  /**
   * Notes that core's audit outbox holds the event of the abandonment of
   * `target` as of run `attempt` (store-abandon.ts), so the alarm doesn't
   * record it again.
   */
  markAbandonmentAudited(
    storeId: StoreId,
    target: string,
    attempt: number
  ): void {
    this.ctx.storage.transactionSync(() => {
      this.#bind(storeId, false);
      this.#db
        .update(abandonedTargets)
        .set({ auditedAt: Date.now() })
        .where(
          and(
            eq(abandonedTargets.targetHash, target),
            eq(abandonedTargets.attempt, attempt)
          )
        )
        .run();
    });
  }

  /**
   * Records in core's audit outbox every abandonment it isn't known to
   * hold yet (one whose core call stopped after the store abandoned it),
   * as core does (store-abandon.ts): the same event, made from the record
   * alone, so it is held once whoever records it.
   */
  async #recordAbandonments(): Promise<void> {
    const unaudited = this.#db
      .select()
      .from(abandonedTargets)
      .where(isNull(abandonedTargets.auditedAt))
      .all();
    if (unaudited.length === 0) {
      return;
    }
    const storeId = this.#storeId();
    for (const row of unaudited) {
      // One after the other: each is marked once its own event is held.
      // oxlint-disable-next-line no-await-in-loop -- see above
      await recordBackfillAbandoned(this.env, storeId, abandonmentOf(row));
      this.#db
        .update(abandonedTargets)
        .set({ auditedAt: Date.now() })
        .where(
          and(
            eq(abandonedTargets.targetHash, row.targetHash),
            eq(abandonedTargets.attempt, row.attempt)
          )
        )
        .run();
    }
  }

  /**
   * Whether the schema `schemaHash`, which the store recorded, is in
   * force (for `consumer`, when named): `abandoned` when the consumer's
   * receipt for it waited on a target an admin abandoned, or no consumer
   * is named and only such a target held it; `active` when the store's
   * contract holds it; `pending` or `failed`, with its backfill's
   * progress, when only the pending target holds it; `unknown` for a
   * schema the store wasn't handed (or holds in neither, which a store
   * whose metadata is intact never does); `incompatible` for one an
   * explicit migration left behind. What core asks before it makes a
   * release current on the store.
   */
  schemaStatus(
    storeId: StoreId,
    schemaHash: string,
    consumer?: SchemaConsumer
  ): SchemaStatus {
    const hash = dataErrors.parse(
      "data.invalid",
      backfillTargetSchema,
      schemaHash
    );
    const named =
      consumer === undefined
        ? undefined
        : dataErrors.parse("data.invalid", schemaConsumerSchema, consumer);
    return this.ctx.storage.transactionSync((): SchemaStatus => {
      this.#bind(storeId, false);
      const recorded = this.#db
        .select({
          manifest: schemas.manifest,
          abandonedAt: schemas.abandonedAt,
          supersededAt: schemas.supersededAt,
        })
        .from(schemas)
        .where(eq(schemas.schemaHash, hash))
        .get();
      if (recorded === undefined) {
        return { state: "unknown" };
      }
      const receipt =
        named === undefined
          ? undefined
          : this.#db
              .select({ abandonedAt: schemaActivations.abandonedAt })
              .from(schemaActivations)
              .where(
                and(
                  eq(schemaActivations.resourceId, named.resourceId),
                  eq(schemaActivations.resourceVersion, named.resourceVersion),
                  eq(schemaActivations.schemaHash, hash)
                )
              )
              .get();
      if (
        (receipt !== undefined && receipt.abandonedAt !== null) ||
        recorded.abandonedAt !== null
      ) {
        return { state: "abandoned" };
      }
      if (recorded.supersededAt !== null) {
        // Writes under it are refused for good (`#requireInForce`), so it
        // never runs on the store again, even should a contract cover it.
        return { state: "incompatible" };
      }
      const schema = readSchemaManifest(recorded.manifest).manifest;
      const row = this.#db
        .select({ text: store.contractManifest })
        .from(store)
        .get();
      const contract =
        row?.text === null || row?.text === undefined
          ? null
          : readSchemaManifest(row.text).manifest;
      if (covered(planSchemaChange(contract, schema))) {
        return { state: "active" };
      }
      const pending = this.#pendingTarget();
      if (
        pending === null ||
        !covered(planSchemaChange(pending.manifest, schema))
      ) {
        return { state: "unknown" };
      }
      let state: "pending" | "failed" | "ready" = "pending";
      if (pending.state === "failed") {
        state = "failed";
      } else if (pending.readyAt !== null) {
        state = "ready";
      }
      return {
        state,
        target: pending.hash,
        attempt: pending.attempt,
        scanned: pending.scanned,
        filled: pending.filled,
        failure: shownFailure(pending.failure, pending.migrations, named),
      };
    });
  }

  /**
   * Which of App `resourceId`'s releases (`candidates`, each its version
   * and the schema it was sealed on) the store's contract holds in force
   * now, as `schemaStatus` would answer `active` for each: their versions,
   * in the order asked. What core names when a rollback to a release a
   * migration left behind is refused (store-backfill.ts). Reads only, and
   * tells core nothing of the store's records.
   */
  compatibleVersions(
    storeId: StoreId,
    resourceId: string,
    candidates: readonly { resourceVersion: number; schemaHash: string }[]
  ): number[] {
    const app = dataErrors.parse("data.invalid", identifierSchema, resourceId);
    const asked = dataErrors.parse(
      "data.invalid",
      releaseCandidatesSchema,
      candidates
    );
    return this.ctx.storage.transactionSync((): number[] => {
      this.#bind(storeId, false);
      const row = this.#db
        .select({ text: store.contractManifest })
        .from(store)
        .get();
      if (row?.text === null || row?.text === undefined) {
        return [];
      }
      const contract = readSchemaManifest(row.text).manifest;
      const fits = new Map<string, boolean>();
      const fitsContract = (hash: string): boolean => {
        const known = fits.get(hash);
        if (known !== undefined) {
          return known;
        }
        const recorded = this.#db
          .select({
            manifest: schemas.manifest,
            abandonedAt: schemas.abandonedAt,
            supersededAt: schemas.supersededAt,
          })
          .from(schemas)
          .where(eq(schemas.schemaHash, hash))
          .get();
        const fit =
          recorded !== undefined &&
          recorded.abandonedAt === null &&
          recorded.supersededAt === null &&
          covered(
            planSchemaChange(
              contract,
              readSchemaManifest(recorded.manifest).manifest
            )
          );
        fits.set(hash, fit);
        return fit;
      };
      const abandonedFor = (resourceVersion: number, hash: string): boolean =>
        this.#db
          .select({ abandonedAt: schemaActivations.abandonedAt })
          .from(schemaActivations)
          .where(
            and(
              eq(schemaActivations.resourceId, app),
              eq(schemaActivations.resourceVersion, resourceVersion),
              eq(schemaActivations.schemaHash, hash),
              isNotNull(schemaActivations.abandonedAt)
            )
          )
          .get() !== undefined;
      return asked
        .filter(
          ({ resourceVersion, schemaHash }) =>
            fitsContract(schemaHash) &&
            !abandonedFor(resourceVersion, schemaHash)
        )
        .map(({ resourceVersion }) => resourceVersion);
    });
  }

  /**
   * The defaulted fields of the store's widest contract, its pending
   * target's when it has one: what every commit fills in (`#flush`).
   * The host's own records of its contract, checked when they were
   * written (`defineTables`); parsed once per hash. Call it inside a
   * transaction.
   */
  #defaultedFields(): DefaultedFields {
    const pending = this.#db
      .select({
        hash: backfills.targetHash,
        text: backfills.targetManifest,
        migrations: backfills.migrations,
      })
      .from(backfills)
      .where(sql`${backfills.state} <> 'complete'`)
      .get();
    const contract = this.#db
      .select({ hash: store.contractHash, text: store.contractManifest })
      .from(store)
      .get();
    const widest =
      pending ??
      (contract?.hash !== null &&
      contract?.hash !== undefined &&
      contract.text !== null
        ? { hash: contract.hash, text: contract.text }
        : undefined);
    if (widest === undefined) {
      return new Map();
    }
    // Keyed by the target and the contract in force together: while a
    // migration runs its tables are filled in as the contract has them,
    // and once it took over the contract's hash is the target's, whose
    // defaults those no longer are.
    const key =
      pending === undefined
        ? `contract:${widest.hash}`
        : `pending:${widest.hash}:${contract?.hash ?? ""}`;
    const known = this.#defaults.get(key);
    if (known !== undefined) {
      return known;
    }
    let defaulted = defaultedFieldsOf(readSchemaManifest(widest.text).manifest);
    if (pending?.migrations !== null && pending?.migrations !== undefined) {
      // A table an explicit migration transforms is filled in as the
      // contract in force has it, not the target: a write the target
      // doesn't fit yet is queued for the transform (`#flush`), never
      // made to fit with a default.
      const migrated = new Set(
        pendingMigrationsSchema
          .parse(JSON.parse(pending.migrations))
          .migrations.map(([table]) => table)
      );
      const kept =
        contract?.text === null || contract?.text === undefined
          ? new Map<string, readonly DefaultedField[]>()
          : defaultedFieldsOf(readSchemaManifest(contract.text).manifest);
      defaulted = new Map([
        ...[...defaulted].filter(([table]) => !migrated.has(table)),
        ...[...kept].filter(([table]) => migrated.has(table)),
      ]);
    }
    this.#defaults.set(key, defaulted);
    return defaulted;
  }

  /**
   * The pending target's explicit migration, as a commit queues work for
   * it (`#flush`): its hash, the schema it transforms to and the tables it
   * migrates; null while none runs. Call it inside a transaction.
   */
  #migrating(): {
    target: string;
    schema: string;
    tables: ReadonlySet<string>;
  } | null {
    const pending = this.#pendingTarget();
    if (pending?.migrations === null || pending?.migrations === undefined) {
      return null;
    }
    return {
      target: pending.hash,
      schema: pending.migrations.schema,
      tables: new Set(pending.migrations.migrations.map(([table]) => table)),
    };
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
        .set({ settledAt: clock(), undeliverable: code })
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
    try {
      await this.#recordAbandonments();
    } catch (error) {
      failed = true;
      log.error("store.abandonment_audit_failed", errorFields(error));
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
      await this.#keepBackfillGoing();
    } catch (error) {
      // Not the alarm's failure: its next look is a lease's time away
      // anyway (#backfillDueAt), and the outbox shouldn't wait for it.
      log.error("store.backfill_failed", errorFields(error));
    } finally {
      await this.schedule(failed ? alarmRetryMs : alarmGapMs);
    }
  }

  /**
   * The alarm's look at a running backfill whose run's lease ran out, or
   * never started: core's own way of keeping it going
   * (store-backfill.ts), with this host for its store. So a backfill
   * whose run stopped is handed over to a new one whatever App, if any,
   * comes back to it; a run that keeps renewing its lease is left be.
   * The store's object has core's env, as its deletion's record in core
   * does (store-deletion.ts).
   */
  async #keepBackfillGoing(): Promise<void> {
    const now = Date.now();
    // Looked at only when due, and marked looked at before anything else,
    // so neither an alarm fired for something else nor one that fails
    // here asks the engine again before another lease's time.
    const storeId = this.ctx.storage.transactionSync((): StoreId | null => {
      const row = this.#db
        .select({
          storeId: store.storeId,
          targetHash: backfills.targetHash,
          leaseUntil: backfills.leaseUntil,
          lookedAt: backfills.lookedAt,
          createdAt: backfills.createdAt,
        })
        .from(backfills)
        .innerJoin(store, sql`1 = 1`)
        // A ready migration has no run to look after.
        .where(and(eq(backfills.state, "running"), isNull(backfills.readyAt)))
        .get();
      if (row === undefined || backfillDueAt(row) > now) {
        return null;
      }
      this.#db
        .update(backfills)
        .set({ lookedAt: now })
        .where(eq(backfills.targetHash, row.targetHash))
        .run();
      return storeIdSchema.parse(row.storeId);
    });
    if (storeId === null) {
      return;
    }
    await keepStoreBackfillGoing(this.env, {
      id: storeId,
      status: async () => await Promise.resolve(this.backfillStatus(storeId)),
      retry: async (target) => await this.retryBackfill(storeId, target),
      restart: async (restart) => await this.restartBackfill(storeId, restart),
    });
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
          `SELECT (EXISTS (SELECT 1 FROM sdk_store WHERE inventoried_at IS NULL) ${purgedTables.map((table) => `OR EXISTS (SELECT 1 FROM ${table})`).join(" ")}) AS left`
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
    // An abandonment core isn't known to hold the event of: recorded now.
    const unaudited = this.#db
      .select({ at: abandonedTargets.abandonedAt })
      .from(abandonedTargets)
      .where(isNull(abandonedTargets.auditedAt))
      .get();
    // A running backfill: looked at when it is due (`backfillDueAt`); a
    // ready migration has no run, so it is due for nothing.
    const backfill = this.#db
      .select({
        leaseUntil: backfills.leaseUntil,
        lookedAt: backfills.lookedAt,
        createdAt: backfills.createdAt,
      })
      .from(backfills)
      .where(and(eq(backfills.state, "running"), isNull(backfills.readyAt)))
      .get();
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
    const times = [
      cascading === undefined ? null : Date.now(),
      typeof failedJob?.at === "number"
        ? failedJob.at + cascadeFailedRetryMs
        : null,
      entry?.at,
      receipt?.at,
      // A file expiring, or a deleted file's bytes due for purging.
      this.files.nextDue(),
      unaudited === undefined ? null : Date.now(),
      backfill === undefined ? null : backfillDueAt(backfill),
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
      // Its abandonments' events first: the purge takes their records.
      await this.#recordAbandonments();
      await recordStoreDeleted(this.env, storeId, markOf(bound));
      // Only once core's inventory shows it: a row that went missing
      // (or a batch that didn't land) is retried, never purged past.
      if (!(await inventoriedDeleted(this.env, storeId))) {
        throw new Error("Core's inventory doesn't show the store deleted");
      }
      this.#db.update(store).set({ inventoriedAt: Date.now() }).run();
    }
    // The cursor key goes with what it sealed: nothing is left to page.
    this.#db.update(store).set({ cursorKey: null }).run();
    this.#keys = undefined;
    // Its files' bytes before their rows: a purge stopped between them
    // finds the bytes gone and the rows still there, never the reverse.
    if (this.#db.select({ id: files.fileId }).from(files).get() !== undefined) {
      await this.files.purgeStore(storeIdSchema.parse(bound.storeId));
    }
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
