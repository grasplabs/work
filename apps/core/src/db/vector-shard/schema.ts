/**
 * A vector shard's Durable Object SQLite (knowledge/vector-shard.ts): the
 * vectors of one (generation, policy key, sub-shard).
 */
import { blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const vectors = sqliteTable("vectors", {
  id: text().primaryKey(),
  /**
   * The catalog's sequence of the write that set this row last. A write
   * with a lower one arrived late and changes nothing.
   */
  seq: integer().notNull(),
  /** The vector as float32; null once removed (a tombstone, see `seq`). */
  vec: blob({ mode: "buffer" }),
});
