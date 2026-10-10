/**
 * A business store's Durable Object SQLite (data-store.ts): the host's own
 * fixed layout, the same in every store, whatever the store's schema. A
 * store's logical tables are rows of `sdk_tables`, and its records rows of
 * `sdk_records`, each record's fields one JSON document: a field or a
 * table an author declares never becomes a SQL column or table. Changing
 * this layout is a platform upgrade, migrated on the first wake-up after a
 * release.
 */
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
