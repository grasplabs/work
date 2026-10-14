/**
 * A business store's Durable Object SQLite (data-store.ts): the host's own
 * fixed layout, the same in every store, whatever the store's schema. A
 * store's logical tables are rows of `sdk_tables`, and its records rows of
 * `sdk_records`, each record's fields one JSON document: a field or a
 * table an author declares never becomes a SQL column or table. Changing
 * this layout is a platform upgrade, migrated on the first wake-up after a
 * release.
 */
import { storeOutboxKinds } from "@grasp-os/shared/stores";
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
     * The key the store signs its page cursors with (store-cursors.ts):
     * 32 random bytes in hex, made on first use, never leaving the store.
     */
    cursorKey: text("cursor_key"),
    /**
     * The store's data contract (store-host.ts, `defineTables`): every
     * table and field of every schema the store accepted, as a canonical
     * schema manifest, and its hash. Every record the store holds, and
     * every record a version sealed on it may write, fits it. Both null
     * until the store's first schema, and written together; host-only,
     * never a caller's.
     */
    contractHash: text("contract_hash"),
    contractManifest: text("contract_manifest"),
  },
  (table) => [check("sdk_store_only", sql`${table.only} = 1`)]
);

/**
 * The store's logical tables, by the name the schema gives them, each
 * with an ID the host mints. Records name their table by that ID, so a
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
 * Every schema the store was handed, by its hash, with its canonical
 * manifest: what a read pinned to that schema is checked against, and
 * whose indexes it reads through. Kept as long as the store, so a
 * consumer pinned to an older schema keeps its indexes (store-indexes.ts);
 * nothing here is activated, and nothing removes a row.
 */
export const schemas = sqliteTable("sdk_schemas", {
  schemaHash: text("schema_hash").primaryKey(),
  manifest: text().notNull(),
  createdAt: integer("created_at").notNull(),
  /**
   * When an admin abandoned the pending target that alone held this
   * schema (store-host.ts, `abandonBackfill`): the contract never took
   * it, so it is left out of the check of the contract against the
   * store's schemas, and of a contract rebuilt from them, until a later
   * consumer applies it again.
   */
  abandonedAt: integer("abandoned_at"),
  /**
   * When an explicit migration's target became the contract and this
   * schema no longer fit it (store-host.ts, `#activate`): its records
   * moved on, so a write under it is refused
   * (`migration.incompatible_write`), and the check of the contract
   * against the store's schemas leaves it out. Reads under it go on: a
   * migration's output fits the contract it ran under.
   */
  supersededAt: integer("superseded_at"),
});

/**
 * What applying a schema to the store's contract did, for the consumer
 * it was applied for (a resource's version, e.g. an App's sealed
 * release): the contract before and after, the plan's hash and the plan.
 * One per consumer and schema, written in the transaction that moved the
 * contract, so it exists exactly when the store committed that consumer's
 * schema; applying it again answers this receipt and changes nothing.
 */
export const schemaActivations = sqliteTable("sdk_schema_activations", {
  /** The SHA-256 of the consumer and the schema's hash. */
  receiptId: text("receipt_id").primaryKey(),
  resourceId: text("resource_id").notNull(),
  resourceVersion: integer("resource_version").notNull(),
  schemaHash: text("schema_hash").notNull(),
  /** The contract's hash before; null for the store's first schema. */
  baseHash: text("base_hash"),
  contractHash: text("contract_hash").notNull(),
  planHash: text("plan_hash").notNull(),
  /** The plan, as canonical JSON: what it added and retained. */
  plan: text().notNull(),
  createdAt: integer("created_at").notNull(),
  /**
   * When the pending target this receipt waited on was abandoned
   * (store-host.ts, `abandonBackfill`): its consumer's release never runs
   * on the store, and applying its schema for it again is refused
   * (`migration.abandoned`) rather than making it pending once more.
   */
  abandonedAt: integer("abandoned_at"),
});

/**
 * The fields an abandoned pending target added (store-host.ts,
 * `abandonBackfill`), each with its descriptor: records its backfill
 * filled in keep the value, so a later schema may add the field again
 * only as it was (`planSchemaChange`'s `reserved`), never with another
 * meaning those values wouldn't fit.
 */
export const reservedFields = sqliteTable(
  "sdk_reserved_fields",
  {
    tableName: text("table_name").notNull(),
    fieldName: text("field_name").notNull(),
    /** The field's value descriptor, as canonical JSON. */
    descriptor: text().notNull(),
    /** The abandoned target that reserved it first. */
    targetHash: text("target_hash").notNull(),
    reservedAt: integer("reserved_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.tableName, table.fieldName] })]
);

/**
 * Pending targets an admin abandoned (store-host.ts, `abandonBackfill`),
 * by target: what the backfill had done and why it failed, the schemas
 * and receipts it took out of force and the fields it reserved, and who
 * abandoned it when. The abandonment's record, which its audit event is
 * made from alone, so core and the store's alarm make the same event;
 * `audited_at` is set once core holds it.
 */
export const abandonedTargets = sqliteTable(
  "sdk_abandoned_targets",
  {
    targetHash: text("target_hash").notNull(),
    baseHash: text("base_hash"),
    /** The run abandoned: a new pending target of this hash goes on past it. */
    attempt: integer().notNull(),
    scanned: integer().notNull(),
    filled: integer().notNull(),
    /** Why its backfill failed (JSON). */
    failure: text().notNull(),
    /** The schemas taken out of force, as canonical JSON: `[hash, ...]`. */
    schemas: text().notNull(),
    /** The receipts abandoned, as canonical JSON: `[[resource, version], ...]`. */
    consumers: text().notNull(),
    /** The fields reserved, as canonical JSON: `[[table, field], ...]`. */
    reserved: text().notNull(),
    /** Who abandoned it, as the audit log names them (JSON). */
    abandonedBy: text("abandoned_by").notNull(),
    abandonedAt: integer("abandoned_at").notNull(),
    /** When core's audit outbox was found to hold its event. */
    auditedAt: integer("audited_at"),
  },
  // One per run abandoned: a target added back as it was goes on from a
  // later run, and its abandonment is a record of its own.
  (table) => [primaryKey({ columns: [table.targetHash, table.attempt] })]
);

/**
 * A schema change the store took but whose contract isn't in force yet:
 * the pending target (spec 17.4 step 4), kept apart from the contract in
 * `sdk_store`, with the bounded fill-missing backfill that has to finish
 * before the contract moves to it (store-host.ts, `fillMissing`). At most
 * one is pending (running or failed) at a time; a completed one stays as
 * the receipt of its activation.
 */
export const backfills = sqliteTable(
  "sdk_schema_backfills",
  {
    /** The hash of the pending contract: the target's identity. */
    targetHash: text("target_hash").primaryKey(),
    /** The pending contract, as canonical manifest text. */
    targetManifest: text("target_manifest").notNull(),
    /**
     * The contract hash `sdk_store` held when the change was planned:
     * activation compares and sets against it. Null for a contract the
     * store's row didn't hold (rebuilt from its schemas).
     */
    baseHash: text("base_hash"),
    /** The fields to fill, as canonical JSON: `[[table, field], ...]`. */
    fills: text().notNull(),
    /**
     * Where the scan ends in each table it fills, as canonical JSON
     * `{tableId: recordId}`: the highest record ID the table held when the
     * target became pending. Every commit since filled in what it wrote,
     * so nothing past it needs a look; a table that held no record then
     * isn't scanned.
     */
    scanBounds: text("scan_bounds").notNull(),
    state: text({ enum: ["running", "complete", "failed"] }).notNull(),
    /**
     * The fence: the run of the backfill the store answers, moved on when
     * a new run takes over from one that ended (`restartBackfill`).
     */
    attempt: integer().notNull().default(1),
    /** Until when the current run's lease holds, by the store's clock. */
    leaseUntil: integer("lease_until"),
    /**
     * When the backfill's run was last looked after: handed over
     * (`restartBackfill`), or found going by the store's alarm. The next
     * look is due at the end of the run's lease, or a lease's time after
     * this once that ended (store-host.ts, `#backfillDueAt`).
     */
    lookedAt: integer("looked_at"),
    /**
     * Hand-overs in a row that found no progress since the last
     * (`scanned` still `stall_scanned`): the third fails the backfill as
     * stalled, rather than starting runs that can't move on, forever.
     */
    stalls: integer().notNull().default(0),
    stallScanned: integer("stall_scanned"),
    /** The last batch the current run committed, and what it answered. */
    lastBatch: integer("last_batch").notNull().default(0),
    lastOutcome: text("last_outcome"),
    /** Where the scan is: the table and record it reached last. */
    cursorTable: text("cursor_table"),
    cursorRecord: text("cursor_record"),
    /**
     * For an explicit migration (`migrations`), the rest of where its scan
     * is: it goes through a table's records by owner, then creation time,
     * then ID, so a batch holds one owner's records where the table's
     * access is `owner` (store-migrations.ts).
     */
    cursorOwner: text("cursor_owner"),
    cursorCreatedAt: integer("cursor_created_at"),
    /**
     * The explicit migrations the target runs instead of filling, as
     * canonical JSON `{ consumer: [resource, version], migrations:
     * [[table, name], ...] }`: the release whose transforms run, one per
     * table. Null for a fill-missing target.
     */
    migrations: text(),
    /**
     * An explicit migration's phase: `scan` through the records the
     * tables held when it became pending, then `work` through the records
     * concurrent writes left not fitting the target
     * (`sdk_migration_work`).
     */
    phase: text({ enum: ["scan", "work"] })
      .notNull()
      .default("scan"),
    /**
     * When an explicit migration found its scan through and no work left:
     * ready, its contract taking over only as a release sealed on it is
     * made current (store-host.ts, `activateReady`), so the version
     * still current goes on writing until then. Cleared when a write
     * queues work again.
     */
    readyAt: integer("ready_at"),
    /** Records looked at, and records filled in, so far. */
    scanned: integer().notNull().default(0),
    filled: integer().notNull().default(0),
    /** For a failed backfill: the record whose value doesn't fit (JSON). */
    failure: text(),
    /**
     * The revision that record was at when it failed the backfill: a
     * retry runs only once it moved on (`retryBackfill`), so a failure
     * nobody changed anything for isn't retried in a loop.
     */
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
    // One pending target at a time, running or failed: unique on whether
    // it is pending, so a running and a failed one can't both be there.
    uniqueIndex("sdk_schema_backfills_one_pending")
      .on(sql`(${table.state} <> 'complete')`)
      .where(sql`state <> 'complete'`),
  ]
);

/**
 * Records an explicit migration still has to transform once its scan is
 * through (store-migrations.ts): written in the transaction of a commit
 * that left a record of a migrated table not fitting the pending target,
 * or of a batch whose record changed since it was read. Its activation
 * waits until none is left; a record that fits by then is dropped.
 */
export const migrationWork = sqliteTable(
  "sdk_migration_work",
  {
    targetHash: text("target_hash").notNull(),
    tableId: text("table_id").notNull(),
    recordId: text("record_id").notNull(),
    ownerId: text("owner_id").notNull(),
    queuedAt: integer("queued_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.targetHash, table.tableId, table.recordId],
    }),
    // A batch's records: one table's, by owner then ID.
    index("sdk_migration_work_batches").on(
      table.targetHash,
      table.tableId,
      table.ownerId,
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
    kind: text({ enum: storeOutboxKinds }).notNull(),
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
