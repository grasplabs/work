/**
 * The vector catalog's Durable Object SQLite (knowledge/vector-catalog.ts):
 * which generations the deployment's `sqlite` vector index has, and for
 * each record of each, the shard that holds its vector. The vectors
 * themselves are in the shards (db/vector-shard).
 */
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/** One generation, from `create` until `drop` is done. */
export const generations = sqliteTable("generations", {
  id: text().primaryKey(),
  /** Everything the generation was made with (`VectorGeneration`), as JSON. */
  spec: text().notNull(),
  /** `dropping` from when a drop starts: then nothing reads or writes it. */
  state: text({ enum: ["ready", "dropping"] }).notNull(),
  /** The last write sequence handed out: every write takes the next. */
  seq: integer().notNull().default(0),
});

/**
 * One record of a generation: the shard its vector is in, a shard being
 * one (generation, policy key, sub-shard) Durable Object.
 */
export const entries = sqliteTable(
  "entries",
  {
    generation: text().notNull(),
    id: text().notNull(),
    policy: text().notNull(),
    shard: integer().notNull(),
    /** The write that placed it last: a shard keeps only the latest. */
    seq: integer().notNull(),
    /** Its source version, once the write that placed it is done. */
    version: text(),
    /**
     * 1 from when a write or delete of it starts until it is done: if that
     * write failed, its vector may or may not be in its shard.
     */
    pending: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.generation, table.id] }),
    index("entries_shard").on(table.generation, table.policy, table.shard),
  ]
);

/**
 * Where a record was before a write moved it to another policy key: its
 * vector there is removed before the write puts it in its new shard, and
 * the row stays until that removal is done.
 */
export const moving = sqliteTable(
  "moving",
  {
    generation: text().notNull(),
    id: text().notNull(),
    policy: text().notNull(),
    shard: integer().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.generation, table.id, table.policy, table.shard],
    }),
  ]
);
