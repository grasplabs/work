/**
 * A business store's Durable Object SQLite (data-store.ts): the host's own
 * fixed layout, the same in every store, whatever the store's schema. A
 * store's logical tables are rows of `sdk_tables`, and its records rows of
 * `sdk_records`, each record's fields one JSON document: a field or a
 * table an author declares never becomes a SQL column or table. Changing
 * this layout is a platform upgrade, migrated on the first wake-up after a
 * release.
 */
import { sql } from "drizzle-orm";
import {
  check,
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
