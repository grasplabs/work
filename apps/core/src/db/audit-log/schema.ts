/**
 * Audit log Durable Object SQLite: append-only, hash-chained events. Migrates
 * itself on first wake-up after a release.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * The chain as the log holds it: one row per event, never updated. Rows
 * leave only when retention archives them, oldest first (`archives`).
 */
export const events = sqliteTable(
  "events",
  {
    /** Position in the chain, from 1, without gaps. */
    seq: integer().primaryKey(),
    /** The event's own ID; unique, so a redelivered event is appended once. */
    id: text().notNull().unique(),
    /** The hash format the row was hashed with. */
    version: integer().notNull(),
    /** When the log received the event (ISO 8601), set by the log. */
    receivedAt: text("received_at").notNull(),
    /** The event's canonical JSON, exactly as it was hashed. */
    event: text().notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text().notNull(),
  },
  (table) => [
    check("events_seq_positive", sql`${table.seq} >= 1`),
    // Searches by time turn their range into positions with it.
    index("events_received_at_idx").on(table.receivedAt),
  ]
);

/**
 * Stretches of the chain moved out to R2 by retention, oldest first and
 * without gaps: each one the entries from `firstSeq` to `lastSeq`, stored as
 * they were, linked to the hash before them (`prevHash`) and ending on
 * `lastHash`, where the next stretch, or the first row of `events`, picks
 * the chain up again. A stretch purged by retention keeps its row, so the
 * chain still links across it; only its object is gone.
 */
export const archives = sqliteTable("archives", {
  firstSeq: integer("first_seq").primaryKey(),
  lastSeq: integer("last_seq").notNull().unique(),
  prevHash: text("prev_hash").notNull(),
  lastHash: text("last_hash").notNull(),
  /** When the log received the stretch's last event (ISO 8601). */
  lastReceivedAt: text("last_received_at").notNull(),
  /** The object in the AUDIT_ARCHIVE bucket that holds the entries. */
  key: text().notNull(),
  archivedAt: text("archived_at").notNull(),
  /**
   * When the log purged the stretch (ISO 8601): recorded as `audit.purged`
   * before its object was deleted. `null` while the object is kept.
   */
  purgedAt: text("purged_at"),
  /**
   * When the purged stretch's object was deleted (ISO 8601). `null` while
   * a purged stretch's delete hasn't succeeded yet: the next purge tries
   * it again.
   */
  deletedAt: text("deleted_at"),
});

/**
 * Who did something themselves in which week, for the admin's summary
 * (core's admin-summary.ts): one row for each person in each week in which
 * the log appended an event whose actor is them (`actor.type` `person`),
 * written with that event, in its transaction (`AuditLog.#append`). The
 * week is the Monday, in UTC, of the event's own `at`. Kept as long as the
 * events are (retention removes older weeks). It fills from the release
 * that added it on: weeks before hold no rows, with nothing filled in
 * after the fact, as nothing is before the first release.
 */
export const activeWeeks = sqliteTable(
  "active_weeks",
  {
    /** The week's Monday, `YYYY-MM-DD`, in UTC. */
    week: text().notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.week, table.userId] })]
);
