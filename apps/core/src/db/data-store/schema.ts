/**
 * A business store's Durable Object SQLite (data-store.ts): the host's own
 * fixed layout, the same in every store, whatever the store's schema. A
 * store's logical tables are rows of `sdk_tables`, and its records rows of
 * `sdk_records`, each record's fields one JSON document: a field or a
 * table an author declares never becomes a SQL column or table. Changing
 * this layout is a platform upgrade, migrated on the first wake-up after a
 * release.
 */
import {
  recordChangeSources,
  valuesLeftOutReasons,
} from "@grasp-os/shared/app-data";
import { storeIntentKinds } from "@grasp-os/shared/stores";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Which store this object is: written by the first call into it and
 * checked by every call after, so an object reached under one store's ID
 * never serves another's (`only` keeps it to one row).
 */
export const store = sqliteTable(
  "sdk_store",
  {
    only: integer().primaryKey(),
    storeId: text("store_id").notNull(),
    createdAt: integer("created_at").notNull(),
    /** How many commits the store has made: each commit's place in order. */
    commits: integer().notNull().default(0),
    /**
     * When the store was deleted: from then on the object serves nothing,
     * and its alarm purges what it held, keeping only this row.
     */
    deletedAt: integer("deleted_at"),
    /** Who deleted it, as the audit log names them (JSON). */
    deletedBy: text("deleted_by"),
    /**
     * When core's inventory was found to record the deletion: the purge
     * waits for it, so no record goes unaudited.
     */
    inventoriedAt: integer("inventoried_at"),
    /**
     * Unused since cursors became plain keyset cursors (store-cursors.ts).
     * Kept for one release so a rolled-back core, which still signs its
     * cursors with it, keeps paging; dropped in the release after.
     */
    cursorKey: text("cursor_key"),
    /**
     * The schema in force (store-host.ts, `applySchema`), as a canonical
     * schema manifest, and its hash: the one schema the store reads and
     * writes under. Both null until the store's first schema, and written
     * together with the catalog; host-only, never a caller's.
     */
    contractHash: text("contract_hash"),
    contractManifest: text("contract_manifest"),
    /**
     * Every table and field the store holds values of, by stable ID, with
     * its name and type, those the schema in force left out included
     * (schema-changes.ts, `Catalog`), as canonical JSON: what the next
     * schema is diffed against.
     */
    schemaCatalog: text("schema_catalog"),
    /**
     * The version of the App whose schema is in force, and when it was
     * applied: a publish applies its schema only over the version it was
     * based on (store-host.ts, `applySchema`).
     */
    schemaVersion: integer("schema_version"),
    schemaAppliedAt: integer("schema_applied_at"),
    /**
     * What App preferences kept of a store, which nothing reads or writes
     * since they were removed: kept because Durable Object SQLite only
     * expands, and dropped in the contract step (GRA-1550).
     */
    preferencesContract: text("preferences_contract"),
    /**
     * How many bytes the store's change history holds
     * (`sdk_record_changes.bytes`, summed): kept with each change added
     * and removed, so retention's byte bound costs no scan.
     */
    historyBytes: integer("history_bytes").notNull().default(0),
  },
  (table) => [check("sdk_store_only", sql`${table.only} = 1`)]
);

/**
 * The store's logical tables, by the name the schema gives them, each
 * with its stable ID from the App's definition. Records name their table by that ID, so a
 * name never reaches SQL. Names are unique without regard to case
 * (`name_key`).
 */
export const tables = sqliteTable(
  "sdk_tables",
  {
    tableId: text("table_id").primaryKey(),
    name: text().notNull(),
    /** The name in lower case, so `Notes` and `notes` can't both exist. */
    nameKey: text("name_key").notNull(),
    createdAt: integer("created_at").notNull(),
    /**
     * How many commits have changed the table's records: what a read of
     * the table depends on, so a read set is known stale once a commit
     * changed a table it read, whether or not its records matched.
     */
    generation: integer().notNull().default(0),
    /**
     * Whether any schema handed to the store declared the table sensitive
     * (`defineTable(...).sensitive()`): its change history keeps field
     * names only from then on, and its values kept before were cleared
     * as it was set. Never unset.
     */
    sensitive: integer({ mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    uniqueIndex("sdk_tables_name_key").on(table.nameKey),
    check(
      "sdk_tables_name_key_lower",
      sql`${table.nameKey} = lower(${table.name})`
    ),
  ]
);

/**
 * The records of every logical table. The managed fields (`_id`,
 * `_ownerId`, `_rev`, `_createdAt`, `_updatedAt`) are these fixed columns,
 * which only the host sets; the fields the schema declares are the JSON
 * object in `value_json`. `schema_hash` names the schema of the last
 * commit that changed the record: a commit that leaves it as it was
 * doesn't stamp it again, and a compatible schema change needn't rewrite
 * it.
 */
export const records = sqliteTable(
  "sdk_records",
  {
    tableId: text("table_id")
      .notNull()
      .references(() => tables.tableId),
    recordId: text("record_id").notNull(),
    ownerId: text("owner_id").notNull(),
    revision: integer().notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    valueJson: text("value_json").notNull(),
    schemaHash: text("schema_hash").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tableId, table.recordId] }),
    check("sdk_records_revision", sql`${table.revision} >= 1`),
    check(
      "sdk_records_value",
      sql`json_valid(${table.valueJson}) AND json_type(${table.valueJson}) = 'object'`
    ),
    check("sdk_records_updated", sql`${table.updatedAt} >= ${table.createdAt}`),
    // A table's records in the default order, by creation time with the
    // record ID breaking ties, and the same per owner: what a query
    // without an index reads through (store-indexes.ts). Two fixed indexes
    // serve every table, so a store's tables cost no partial index each.
    index("sdk_records_created").on(
      table.tableId,
      table.createdAt,
      table.recordId
    ),
    index("sdk_records_owner_created").on(
      table.tableId,
      table.ownerId,
      table.createdAt,
      table.recordId
    ),
  ]
);

/**
 * The number each record has in the store's full-text search indexes
 * (store-search.ts): an FTS5 table keys its rows by an integer, and a
 * record's own rowid in `sdk_records` isn't stable (a VACUUM may renumber
 * a table without an integer primary key), so a record gets one here the
 * first time a search index takes it, kept until the record is deleted (a
 * trigger of this migration's), and shared by every search index of its
 * table.
 */
export const searchDocs = sqliteTable(
  "sdk_search_docs",
  {
    doc: integer().primaryKey(),
    docTable: text("doc_table").notNull(),
    docRecord: text("doc_record").notNull(),
  },
  (table) => [
    uniqueIndex("sdk_search_docs_record").on(table.docTable, table.docRecord),
  ]
);

/**
 * The references the store's records make: one row per record and each
 * record ID one of its `v.id` fields holds, as the schema it was written
 * under declares them (store-references.ts). Kept in the transaction that
 * writes the record, so a deletion of a record still referred to is
 * refused in its own transaction (restrict, store-host.ts), or takes the
 * records that refer to it with it where every field holding it says
 * `cascade`.
 */
export const recordRefs = sqliteTable(
  "sdk_record_refs",
  {
    tableId: text("table_id").notNull(),
    recordId: text("record_id").notNull(),
    toTableId: text("to_table_id").notNull(),
    toRecordId: text("to_record_id").notNull(),
    /** Whether deleting the record referred to deletes this one too. */
    cascade: integer({ mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tableId,
        table.recordId,
        table.toTableId,
        table.toRecordId,
      ],
    }),
    // The references to a record, with what a cascade reads of each, so
    // the cascade's lookup (store-host.ts, `#cascade`) reads the index
    // alone.
    index("sdk_record_refs_target_cascade").on(
      table.toTableId,
      table.toRecordId,
      table.cascade,
      table.tableId,
      table.recordId
    ),
  ]
);

/**
 * A mutation's receipt (data-store.ts), under the hash of its scope and
 * key: the hash of its input, the fence the attempt holding it claimed
 * last, and, once its mutation committed, the outcome, committed in the
 * same transaction as its records. Kept until `retain_until`, which each
 * claim and its commit set, and while the workflow run it names is live;
 * then its outcome goes and it stays a tombstone (`expired_at`), so its
 * key reused is refused as expired, until the tombstone goes too.
 */
export const receipts = sqliteTable(
  "sdk_mutation_receipts",
  {
    receiptId: text("receipt_id").primaryKey(),
    /** Its scope, as JSON, for audit and recovery. */
    scope: text().notNull(),
    principal: text().notNull(),
    runId: text("run_id"),
    inputHash: text("input_hash").notNull(),
    fence: integer().notNull(),
    /** When the attempt holding it must commit by, as it claimed. */
    deadline: integer().notNull(),
    createdAt: integer("created_at").notNull(),
    /**
     * The random seed (64 hex digits) the mutation's randomness answers
     * from in every attempt (operations.ts), made with the receipt. The
     * default is only there for SQLite to add the column: its migration
     * gives every receipt made before it a seed of its own.
     */
    seed: text().notNull().default(""),
    retainUntil: integer("retain_until").notNull(),
    expiredAt: integer("expired_at"),
    /** What the mutation answered, as JSON; null until it committed. */
    outcome: text(),
    committedAt: integer("committed_at"),
    /** Its commit's place in the store's order of commits. */
    commit: integer(),
  },
  (table) => [
    check("sdk_mutation_receipts_fence", sql`${table.fence} >= 1`),
    check(
      "sdk_mutation_receipts_committed",
      sql`(${table.outcome} IS NULL) = (${table.committedAt} IS NULL) AND (${table.outcome} IS NULL) = (${table.commit} IS NULL)`
    ),
    // A tombstone keeps no outcome.
    check(
      "sdk_mutation_receipts_tombstone",
      sql`${table.expiredAt} IS NULL OR ${table.outcome} IS NULL`
    ),
    index("sdk_mutation_receipts_retain")
      .on(table.retainUntil)
      .where(sql`expired_at IS NULL`),
    index("sdk_mutation_receipts_expired")
      .on(table.expiredAt)
      .where(sql`expired_at IS NOT NULL`),
  ]
);

/**
 * What committed mutations still have to tell others: their intents,
 * written in the same transaction as their records and receipt, so an
 * entry exists exactly when its mutation committed. An entry's ID is its
 * receipt's with its place among the commit's intents, the same however
 * often it is handed over. Handed over in the order stored until taken,
 * or settled with the code saying why it can't be; its receipt is kept
 * until then.
 */
export const outbox = sqliteTable(
  "sdk_change_outbox",
  {
    id: text().primaryKey(),
    receiptId: text("receipt_id")
      .notNull()
      .references(() => receipts.receiptId),
    position: integer().notNull(),
    kind: text({ enum: storeIntentKinds }).notNull(),
    /** The intent, as JSON. */
    intent: text().notNull(),
    createdAt: integer("created_at").notNull(),
    attempts: integer().notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    settledAt: integer("settled_at"),
    undeliverable: text(),
  },
  (table) => [
    index("sdk_change_outbox_receipt").on(table.receiptId),
    index("sdk_change_outbox_pending")
      .on(table.nextAttemptAt)
      .where(sql`settled_at IS NULL`),
  ]
);

/**
 * Which consumer, another App or a workflow, made each commit through the
 * store's public operations. Unused since each App's store is its own:
 * kept only until a later release drops it, as an older core may still run
 * on this schema (expand, then contract). The purge still clears it.
 */
export const commitWriters = sqliteTable("sdk_commit_writers", {
  /** The commit's place in the store's order of commits. */
  commit: integer().primaryKey(),
  receiptId: text("receipt_id").notNull(),
  resourceId: text("resource_id").notNull(),
  resourceVersion: integer("resource_version").notNull(),
  principal: text().notNull(),
  committedAt: integer("committed_at").notNull(),
});

/**
 * The store's files (spec 9.6, 10.7.5; file-host.ts): one row per upload,
 * its bytes in the deployment's private R2, in chunks under the store's
 * own prefix. `uploading` until its bytes are checked (size, hash, type),
 * then `published`; `deleted` once cancelled, expired, deleted by its
 * uploader or cleaned up, its bytes removed after (`purgedAt`). A row is
 * never removed while the store lives: it is the tombstone a stale
 * cleanup or a reused key is checked against.
 *
 * `expiresAt` is the file's cleanup intent: when an upload's time runs
 * out, or when a published file no record holds is deleted. A commit that
 * takes the last reference to a file sets it, in the same transaction,
 * and one that holds the file again clears it, so a cleanup acts only on
 * what no record holds at the moment it acts.
 */
export const files = sqliteTable(
  "sdk_files",
  {
    fileId: text("file_id").primaryKey(),
    /** The alias of the files resource it was uploaded through. */
    resource: text().notNull(),
    /** Who uploaded it. */
    ownerId: text("owner_id").notNull(),
    name: text().notNull(),
    /** The type it was declared as, and once published, checked to be. */
    mimeType: text("mime_type").notNull(),
    size: integer().notNull(),
    sha256: text().notNull(),
    state: text({ enum: ["uploading", "published", "deleted"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    publishedAt: integer("published_at"),
    deletedAt: integer("deleted_at"),
    /** Why it was deleted. */
    deletedHow: text("deleted_how", {
      enum: ["cancelled", "rejected", "expired", "deleted", "orphaned"],
    }),
    /** The page's key for this upload: a start sent again finds it. */
    beginKey: text("begin_key").notNull(),
    expiresAt: integer("expires_at"),
    /** When its bytes were removed from R2. */
    purgedAt: integer("purged_at"),
  },
  (table) => [
    index("sdk_files_expiring")
      .on(table.expiresAt)
      .where(sql`expires_at IS NOT NULL`),
    index("sdk_files_unpurged")
      .on(table.deletedAt)
      .where(sql`state = 'deleted' AND purged_at IS NULL`),
    index("sdk_files_owner_open")
      .on(table.ownerId)
      .where(sql`state = 'uploading'`),
    // What the quotas count, live files only: a store's tombstones, kept
    // for good, never add to what starting an upload reads.
    index("sdk_files_live")
      .on(table.ownerId, table.state, table.expiresAt, table.size)
      .where(sql`state <> 'deleted'`),
    uniqueIndex("sdk_files_begin_key").on(table.ownerId, table.beginKey),
  ]
);

/**
 * The keys a person deleted their files under: each key one file's, for
 * every deletion that succeeded under it, a first one or one of a file
 * already deleted, so a key never moves to another file.
 */
export const fileDeleteKeys = sqliteTable(
  "sdk_file_delete_keys",
  {
    ownerId: text("owner_id").notNull(),
    key: text().notNull(),
    fileId: text("file_id")
      .notNull()
      .references(() => files.fileId),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.key] })]
);

/**
 * The chunks of a file core holds, each checked against its hash, and the
 * R2 object holding it: a key of its own for every write
 * (`<file>/<index>.<uuid>`), so a chunk once recorded is never written
 * over, and a write that lost to another removes only its own object.
 */
export const fileChunks = sqliteTable(
  "sdk_file_chunks",
  {
    fileId: text("file_id")
      .notNull()
      .references(() => files.fileId),
    index: integer().notNull(),
    size: integer().notNull(),
    sha256: text().notNull(),
    key: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.fileId, table.index] }),
    // What the alarm looks a write's key up by (`fileWrites`).
    index("sdk_file_chunks_key").on(table.key),
  ]
);

/**
 * The R2 keys handed to chunk writes not yet settled (`admitChunk`), so an
 * object whose writer never heard how its recording went (both answers
 * lost) is still removed: once its write has had time to settle, the
 * alarm deletes it unless a chunk is recorded under its key. A write
 * settles by recording (`chunkStored`), which takes its key off; a key
 * the alarm condemned is recorded no more.
 */
export const fileWrites = sqliteTable(
  "sdk_file_writes",
  {
    key: text().primaryKey(),
    fileId: text("file_id")
      .notNull()
      .references(() => files.fileId),
    issuedAt: integer("issued_at").notNull(),
    /** Set once the alarm is removing its object: it is recorded no more. */
    condemned: integer({ mode: "boolean" }).notNull().default(false),
    /**
     * When the alarm last removed its object, once condemned: until then a
     * removal that failed is due again at the alarm's next try, never only
     * at the write's lifetime.
     */
    removedAt: integer("removed_at"),
    /**
     * When the alarm last tried to remove its object: a removal that
     * failed is tried again a retry's wait after (`removalRetryMs`), not
     * at every alarm the store's activity brings forward.
     */
    removeTriedAt: integer("remove_tried_at"),
  },
  (table) => [index("sdk_file_writes_issued").on(table.issuedAt)]
);

/**
 * Audit events of the store's files, written in the transaction that does
 * what they record (a publication, a deletion, a cleanup) and handed to
 * core's audit outbox after (file-host.ts, `flushEvents`), then removed:
 * each lands once, however often the hand-over is retried.
 */
export const fileEvents = sqliteTable("sdk_file_events", {
  id: text().primaryKey(),
  /** The event, as JSON (`AuditEvent`). */
  event: text().notNull(),
  createdAt: integer("created_at").notNull(),
});

/**
 * The files the store's records hold: one row per record and file one of
 * its `v.file()` fields holds, kept in the transaction that writes the
 * record (store-host.ts), as `sdk_record_refs` is.
 */
export const fileRefs = sqliteTable(
  "sdk_file_refs",
  {
    tableId: text("table_id").notNull(),
    recordId: text("record_id").notNull(),
    fileId: text("file_id")
      .notNull()
      .references(() => files.fileId),
  },
  (table) => [
    primaryKey({ columns: [table.tableId, table.recordId, table.fileId] }),
    index("sdk_file_refs_file").on(table.fileId),
  ]
);

/**
 * What App preferences kept, one row per person who ever changed one.
 * Nothing writes it since App preferences were removed (an App keeps each
 * person's settings in a table with an `owner` row rule); kept because
 * Durable Object SQLite only expands, and dropped in the contract step
 * (GRA-1550). Until then a person's erasure removes their rows
 * (store-host.ts, `forgetPerson`), and a deleted store's purge all of
 * them.
 */
export const preferences = sqliteTable("sdk_preferences", {
  personId: text("person_id").primaryKey(),
  revision: integer().notNull(),
  valueJson: text("value_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
  lastKey: text("last_key"),
  lastInputHash: text("last_input_hash"),
  lastAnswerJson: text("last_answer_json"),
});

/**
 * A cascade past one commit's bound (store-host.ts, `#planCascadeJob`): the
 * records a commit's deletions reach by `onDelete: "cascade"`, planned in
 * that commit and deleted by the store's alarm in batches, leaves first.
 * Written in the commit that planned it, with its members; finished once
 * the last member is gone. Who deleted is the commit's principal, and the
 * commit's receipt names the job (`Committed.cascadePending`).
 */
export const cascadeJobs = sqliteTable(
  "sdk_cascade_jobs",
  {
    jobId: text("job_id").primaryKey(),
    receiptId: text("receipt_id").notNull(),
    principal: text().notNull(),
    /**
     * The resource the commit came through (its receipt's scope): the App
     * whose release committed the deletion, or the consumer that called the
     * store's public operation.
     */
    resourceId: text("resource_id"),
    /** The workflow run the commit was made in, if any. */
    runId: text("run_id"),
    /**
     * Who made the commit, as the audit log names them (`AuditActor`, as
     * JSON): whom the change history of each record the job deletes names.
     * SQLite adds a required column only with a default: a job planned
     * before stores kept this (none was released) names the system.
     */
    actor: text().notNull().default('{"type":"system"}'),
    /** The first record the commit itself deleted: what the job is named by. */
    rootTableId: text("root_table_id").notNull(),
    rootRecordId: text("root_record_id").notNull(),
    planned: integer().notNull(),
    deleted: integer().notNull().default(0),
    /**
     * Batches of it that failed in a row: past `cascadeJobMaxAttempts` the
     * job fails (`failedAt`) and is tried again later, its records still
     * deleting until it finishes.
     */
    attempts: integer().notNull().default(0),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
    failedAt: integer("failed_at"),
  },
  (table) => [
    // The jobs still to finish, in the order the alarm takes them: what
    // every commit's and alarm's schedule looks for, which finished jobs,
    // kept for good, never slow down.
    index("sdk_cascade_jobs_unfinished")
      .on(table.attempts, table.createdAt)
      .where(sql`${table.finishedAt} IS NULL`),
  ]
);

/**
 * The records a cascade job still has to delete: one row per record, so a
 * record belongs to one job at most. While it has a row it stays readable,
 * and a write to it or a new reference to it is refused (`data.deleting`);
 * the batch that deletes it removes the row in the same transaction.
 * Only a commit is refused: a schema change applied at publish
 * (store-host.ts, `applySchema`) may still rewrite a deleting record,
 * which the job then deletes as it is.
 */
export const cascadeMembers = sqliteTable(
  "sdk_cascade_members",
  {
    tableId: text("table_id").notNull(),
    recordId: text("record_id").notNull(),
    jobId: text("job_id")
      .notNull()
      .references(() => cascadeJobs.jobId),
  },
  (table) => [
    primaryKey({ columns: [table.tableId, table.recordId] }),
    index("sdk_cascade_members_job").on(table.jobId),
  ]
);

/**
 * The store's change history (store-changes.ts): one row per record a
 * commit, a cascade or an import inserted, updated or deleted, written in
 * the transaction that changed it. Who (`actor`, an `AuditActor` as JSON),
 * when, which table and record, and which fields changed; the changed
 * fields' values before and after only for a table not declared
 * sensitive, and only within `recordChangeLimits.valuesMaxBytes`. Kept
 * `recordChangeLimits.retentionDays`, and at most
 * `recordChangeLimits.maxEntries` rows, pruned by the transactions that
 * add rows. Read by the App's builders and the organization's admins
 * (core's app-data.ts), never by App code.
 */
export const recordChanges = sqliteTable(
  "sdk_record_changes",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    changedAt: integer("changed_at").notNull(),
    /** The commit it was made in, in the store's order; none for a cascade job's batch. */
    commit: integer(),
    tableId: text("table_id").notNull(),
    /** The table's name when it changed. */
    tableName: text("table_name").notNull(),
    recordId: text("record_id").notNull(),
    op: text({ enum: ["insert", "update", "delete"] }).notNull(),
    source: text({ enum: recordChangeSources }).notNull(),
    actor: text().notNull(),
    /**
     * The person the change was made for (the commit's principal, the
     * importer, the cascade's commit's): whose erasure clears its values,
     * whoever acted for them.
     */
    principal: text().notNull(),
    /** The row's size in bytes, as the store's history bound counts it. */
    bytes: integer().notNull(),
    /** The changed fields' names, as a JSON array. */
    fields: text().notNull(),
    /** The changed fields' values before and after, as JSON objects. */
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    /** Why the values aren't kept, if they aren't. */
    valuesLeftOut: text("values_left_out", {
      enum: valuesLeftOutReasons,
    }),
  },
  (table) => [
    // A record's history, newest first.
    index("sdk_record_changes_record").on(
      table.tableId,
      table.recordId,
      table.id
    ),
    // What retention removes first.
    index("sdk_record_changes_changed_at").on(table.changedAt),
  ]
);

/**
 * An import's rows, as core hands them to the store in batches
 * (`StoreHost.stageImport`) before it lands them all in one transaction
 * (`StoreHost.applyImport`), which removes them. Rows an import left
 * staged (its connection lost) are removed by a later import once
 * `importStagedMs` old, and with the store.
 */
export const importRows = sqliteTable(
  "sdk_import_rows",
  {
    importId: text("import_id").notNull(),
    position: integer().notNull(),
    principal: text().notNull(),
    tableName: text("table_name").notNull(),
    recordId: text("record_id").notNull(),
    valueJson: text("value_json").notNull(),
    stagedAt: integer("staged_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.importId, table.position] }),
    index("sdk_import_rows_staged_at").on(table.stagedAt),
  ]
);

/**
 * A migration's output, as core stages it batch by batch
 * (`StoreHost.stageMigration`) before the publish applies it with the
 * schema in one transaction (`StoreHost.applySchema`), which removes it:
 * each record's fields after its transform, with the revision it was read
 * at. Rows a publish left staged are removed as the next migration begins.
 */
export const migrationRows = sqliteTable(
  "sdk_migration_rows",
  {
    migrationId: text("migration_id").notNull(),
    tableId: text("table_id").notNull(),
    recordId: text("record_id").notNull(),
    revision: integer().notNull(),
    valueJson: text("value_json").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.migrationId, table.tableId, table.recordId],
    }),
  ]
);

/*
 * Unused since an App's schema changes apply at publish in one
 * transaction (store-host.ts, `applySchema`): the per-schema records,
 * pending targets, backfills, migration work queues, receipts and rules
 * owed of the contract model before it. Kept so a rolled-back core still
 * opens the store (expand only, one release at a time); dropped in
 * GRA-1550.
 */
export const schemas = sqliteTable("sdk_schemas", {
  schemaHash: text("schema_hash").primaryKey(),
  manifest: text().notNull(),
  createdAt: integer("created_at").notNull(),
  abandonedAt: integer("abandoned_at"),
  supersededAt: integer("superseded_at"),
});

export const schemaActivations = sqliteTable("sdk_schema_activations", {
  receiptId: text("receipt_id").primaryKey(),
  resourceId: text("resource_id").notNull(),
  resourceVersion: integer("resource_version").notNull(),
  schemaHash: text("schema_hash").notNull(),
  baseHash: text("base_hash"),
  contractHash: text("contract_hash").notNull(),
  planHash: text("plan_hash").notNull(),
  plan: text().notNull(),
  answers: text().notNull().default("[]"),
  createdAt: integer("created_at").notNull(),
  abandonedAt: integer("abandoned_at"),
});

export const owedResourceKinds = ["app", "workflow"] as const;

export const rulesOwed = sqliteTable(
  "sdk_rules_owed",
  {
    owedId: text("owed_id").primaryKey(),
    resourceKind: text("resource_kind", { enum: owedResourceKinds }).notNull(),
    resourceId: text("resource_id").notNull(),
    resourceVersion: integer("resource_version").notNull(),
    schemaHash: text("schema_hash").notNull(),
    owedAt: integer("owed_at").notNull(),
    dueAt: integer("due_at").notNull(),
  },
  (table) => [index("sdk_rules_owed_due").on(table.dueAt)]
);

export const reservedFields = sqliteTable(
  "sdk_reserved_fields",
  {
    tableName: text("table_name").notNull(),
    fieldName: text("field_name").notNull(),
    descriptor: text().notNull(),
    targetHash: text("target_hash").notNull(),
    reservedAt: integer("reserved_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.tableName, table.fieldName] })]
);

export const abandonedTargets = sqliteTable(
  "sdk_abandoned_targets",
  {
    targetHash: text("target_hash").notNull(),
    baseHash: text("base_hash"),
    attempt: integer().notNull(),
    scanned: integer().notNull(),
    filled: integer().notNull(),
    failure: text().notNull(),
    schemas: text().notNull(),
    consumers: text().notNull(),
    reserved: text().notNull(),
    abandonedBy: text("abandoned_by").notNull(),
    abandonedAt: integer("abandoned_at").notNull(),
    auditedAt: integer("audited_at"),
  },
  (table) => [primaryKey({ columns: [table.targetHash, table.attempt] })]
);

export const backfills = sqliteTable(
  "sdk_schema_backfills",
  {
    targetHash: text("target_hash").primaryKey(),
    targetManifest: text("target_manifest").notNull(),
    baseHash: text("base_hash"),
    fills: text().notNull(),
    scanBounds: text("scan_bounds").notNull(),
    state: text({ enum: ["running", "complete", "failed"] }).notNull(),
    attempt: integer().notNull().default(1),
    leaseUntil: integer("lease_until"),
    lookedAt: integer("looked_at"),
    stalls: integer().notNull().default(0),
    stallScanned: integer("stall_scanned"),
    lastBatch: integer("last_batch").notNull().default(0),
    lastOutcome: text("last_outcome"),
    cursorTable: text("cursor_table"),
    cursorRecord: text("cursor_record"),
    cursorOwner: text("cursor_owner"),
    cursorCreatedAt: integer("cursor_created_at"),
    migrations: text(),
    phase: text({ enum: ["scan", "work"] })
      .notNull()
      .default("scan"),
    readyAt: integer("ready_at"),
    scanned: integer().notNull().default(0),
    filled: integer().notNull().default(0),
    failure: text(),
    failureRevision: integer("failure_revision"),
    createdAt: integer("created_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (table) => [
    check("sdk_schema_backfills_attempt", sql`${table.attempt} >= 1`),
    check(
      "sdk_schema_backfills_failure",
      sql`(${table.state} = 'failed') = (${table.failure} IS NOT NULL)`
    ),
    uniqueIndex("sdk_schema_backfills_one_pending")
      .on(sql`(${table.state} <> 'complete')`)
      .where(sql`state <> 'complete'`),
  ]
);

export const migrationWork = sqliteTable(
  "sdk_migration_work",
  {
    targetHash: text("target_hash").notNull(),
    tableId: text("table_id").notNull(),
    recordId: text("record_id").notNull(),
    audience: text().notNull(),
    queuedAt: integer("queued_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.targetHash, table.tableId, table.recordId],
    }),
    index("sdk_migration_work_batches").on(
      table.targetHash,
      table.tableId,
      table.audience,
      table.recordId
    ),
  ]
);
