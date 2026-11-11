import { sql } from "drizzle-orm";
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// The store's tables. Who may read is kept once per distinct set of
// readers (`reader_sets`), as its principals (`reader_set_members`), and
// every item points at its set: items that share readers share the set.
// A set is written once, when it is first needed, and never changed
// (migration 0001), so no item's readers change behind it. Group
// membership isn't kept here: the host resolves a reader's groups at each
// recall (contract.ts).

export const readerSets = sqliteTable("reader_sets", {
  id: integer().primaryKey(),
  /** The set's principals, sorted, as JSON: one row per distinct set. */
  key: text().notNull().unique(),
});

/** A principal of a set: a person or a group, never compared across kinds. */
export const readerSetMembers = sqliteTable(
  "reader_set_members",
  {
    readerSet: integer("reader_set")
      .notNull()
      .references(() => readerSets.id),
    kind: text({ enum: ["person", "group"] }).notNull(),
    principal: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.readerSet, table.kind, table.principal] }),
    // A recall finds a reader's sets by their principals.
    index("reader_set_members_principal_idx").on(
      table.kind,
      table.principal,
      table.readerSet
    ),
    check("reader_set_members_kind", sql`${table.kind} IN ('person', 'group')`),
  ]
);

/**
 * The first slice's sources (GRA-1720), from before versions: no longer
 * written or read. A later migration drops it and its words (expand, then
 * contract: a rolled-back core still finds its own tables).
 *
 * A source, whole as given, with its set of readers. Its folded words are
 * indexed in `source_words`, an FTS5 table the store writes with it
 * (words.ts `indexWords`, migration 0001).
 */
export const sources = sqliteTable(
  "sources",
  {
    /** The row the word index points at. */
    row: integer().primaryKey(),
    id: text().notNull().unique(),
    readerSet: integer("reader_set")
      .notNull()
      .references(() => readerSets.id),
    text: text().notNull(),
    addedAt: integer("added_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("sources_reader_set_idx").on(table.readerSet)]
);

/**
 * An original file in R2 (files.ts), under the SHA-256 of its bytes:
 * stored once however many source versions hold the same content, and
 * counted (`refs`) by how many do. A row is written before its file, so
 * no file is ever in R2 without one, and a file is deleted only with its
 * row, once nothing points at it (files.ts `sweepFiles`).
 */
export const files = sqliteTable(
  "files",
  {
    /** SHA-256 of the file's bytes, in hex: its key in R2. */
    hash: text().primaryKey(),
    /** How many source versions point at the file. */
    refs: integer().notNull(),
    /** When an add last wrote, or was about to write, the file to R2. */
    writtenAt: integer("written_at", { mode: "timestamp_ms" }).notNull(),
    /**
     * Until when a delete of the file may still land: a sweep gave up
     * waiting for R2 (files.ts). No add writes the file meanwhile. Null
     * when none is in doubt. Added by the work queue's migration (0004).
     */
    inDoubtUntil: integer("in_doubt_until", { mode: "timestamp_ms" }),
  },
  (table) => [
    // The sweep finds the files nothing points at.
    index("files_unreferenced_idx").on(table.refs, table.writtenAt),
    check("files_refs", sql`${table.refs} >= 0`),
  ]
);

/**
 * A version of a source, never changed once written and never overwritten
 * by the next. `source` is the identity its producer gives (this upload,
 * this chat), the same across versions; `version` counts from 1. Each
 * version has its own readers, and its content is a file in R2.
 */
export const sourceVersions = sqliteTable(
  "source_versions",
  {
    row: integer().primaryKey(),
    source: text().notNull(),
    version: integer().notNull(),
    file: text()
      .notNull()
      .references(() => files.hash),
    readerSet: integer("reader_set")
      .notNull()
      .references(() => readerSets.id),
    addedAt: integer("added_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    unique("source_versions_source_version_unique").on(
      table.source,
      table.version
    ),
    index("source_versions_reader_set_idx").on(table.readerSet),
    index("source_versions_file_idx").on(table.file),
  ]
);

/**
 * Each source's current version: what recall searches. A version becomes
 * visible when this points at it, set in the transaction that writes the
 * version whole (its chunks and their words), so recall never sees half
 * of one. The versions it no longer points at are history.
 */
export const currentVersions = sqliteTable("current_versions", {
  source: text().primaryKey(),
  versionRow: integer("version_row")
    .notNull()
    .unique()
    .references(() => sourceVersions.row),
});

/**
 * The changes each source was added with: a key its producer gives each
 * change (an upstream revision, a message id, an id minted before the
 * first try), and the version the add answered with. The same key again
 * answers with that version, whatever was added since (sources.ts). One
 * row per add, kept with the source; a key may be a message id, so
 * erasing a source (GRA-1729) erases its changes too.
 */
export const sourceChanges = sqliteTable(
  "source_changes",
  {
    source: text().notNull(),
    change: text().notNull(),
    versionRow: integer("version_row")
      .notNull()
      .references(() => sourceVersions.row),
  },
  (table) => [primaryKey({ columns: [table.source, table.change] })]
);

/**
 * A version's text in passages (chunks.ts), in order: what the word index
 * holds (`chunk_words`, written with it: words.ts `indexWords`) and what
 * recall returns. Never changed once written.
 */
export const chunks = sqliteTable(
  "chunks",
  {
    /** The row the word index points at. */
    row: integer().primaryKey(),
    versionRow: integer("version_row")
      .notNull()
      .references(() => sourceVersions.row),
    /** The chunk's place in its version, from 0. */
    position: integer().notNull(),
    text: text().notNull(),
  },
  (table) => [
    unique("chunks_version_position_unique").on(
      table.versionRow,
      table.position
    ),
  ]
);

// The vector way (vectors.ts). A chunk of a current version can hold a
// code per embedding model: a 1-bit code that every search scans, and an
// 8-bit code that re-scores the best candidates. A code takes the set of
// readers of its chunk's version, never one a caller names, and codes are
// grouped by model and set of readers, so a search reads only the groups
// its reader is in.

/**
 * An embedding model, named with its build by the caller: codes of one
 * model are never compared with another's. Its first codes fix its
 * dimensions and its centre.
 */
export const vectorModels = sqliteTable("vector_models", {
  id: integer().primaryKey(),
  /** The model and its build, as the caller names them. */
  name: text().notNull().unique(),
  /** What 1-bit codes are taken against, per dimension, as float64s. */
  centre: blob({ mode: "buffer" }).notNull(),
});

/**
 * Codes of one model and set of readers, packed: the chunks' rows (as
 * float64s) and their 1-bit codes, in the same order. Written once and
 * never changed (migration 0003): a repack writes a new block and deletes
 * the old one.
 */
export const vectorBlocks = sqliteTable(
  "vector_blocks",
  {
    id: integer().primaryKey(),
    model: integer()
      .notNull()
      .references(() => vectorModels.id),
    readerSet: integer("reader_set")
      .notNull()
      .references(() => readerSets.id),
    chunks: blob({ mode: "buffer" }).notNull(),
    bits: blob({ mode: "buffer" }).notNull(),
  },
  (table) => [index("vector_blocks_group_idx").on(table.model, table.readerSet)]
);

/**
 * A chunk's code for a model: in its group's tail while `block` is null,
 * and at `slot` of a packed block once packed. Deleted when its version
 * stops being current; a packed one is then marked removed in its block
 * (`vector_removed`) until a repack drops it.
 */
export const vectorCodes = sqliteTable(
  "vector_codes",
  {
    chunk: integer()
      .notNull()
      .references(() => chunks.row),
    model: integer()
      .notNull()
      .references(() => vectorModels.id),
    /** The set of readers of the chunk's version, as it was put. */
    readerSet: integer("reader_set")
      .notNull()
      .references(() => readerSets.id),
    /** The 1-bit code: a bit per dimension, as uint32s. */
    bits: blob({ mode: "buffer" }).notNull(),
    /** One over the 8-bit code's own length, so scores are its cosine. */
    inverseLength: real("inverse_length").notNull(),
    /** The 8-bit code: the vector, its largest component 127 steps, as int8s. */
    fine: blob({ mode: "buffer" }).notNull(),
    block: integer().references(() => vectorBlocks.id),
    slot: integer(),
  },
  (table) => [
    primaryKey({ columns: [table.chunk, table.model] }),
    // A search reads a group's tail; a pack counts and takes it.
    index("vector_codes_group_idx").on(
      table.model,
      table.readerSet,
      table.block
    ),
    // A repack takes a block's codes back.
    index("vector_codes_block_idx").on(table.block, table.slot),
  ]
);

/** A packed code marked removed: never scored, and gone at the next repack. */
export const vectorRemoved = sqliteTable(
  "vector_removed",
  {
    block: integer()
      .notNull()
      .references(() => vectorBlocks.id),
    slot: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.block, table.slot] })]
);

/**
 * The work queue (work.ts): one row per item of the Brain's background
 * work still to do, deleted once it succeeded. At most one row of a kind
 * and key waits (or is parked) at a time: a newer item replaces it. One
 * more may run beside it, on what was there before.
 */
export const workItems = sqliteTable(
  "work_items",
  {
    id: integer().primaryKey(),
    /** Which work it is: the kind its handler is defined for. */
    kind: text().notNull(),
    /** What it is about, such as a source. */
    key: text().notNull(),
    /** What its handler is given, as JSON. */
    payload: text().notNull(),
    /** Its class, the first first (work.ts `workPriorities`). */
    priority: integer().notNull(),
    /** The connection it belongs to, if any: each has its own limit at once. */
    connection: text(),
    addedAt: integer("added_at", { mode: "timestamp_ms" }).notNull(),
    /**
     * Not claimed before this, in the queue's time (milliseconds): its
     * backoff after a failure, or the model's wait. 0 when due at once.
     */
    notBefore: integer("not_before").notNull(),
    /** Attempts started, each counted before its work starts; given back when a wait ended it. */
    attempts: integer().notNull().default(0),
    /** Times it was parked: it comes back a day later until it was parked three times. */
    parks: integer().notNull().default(0),
    /** Whether the object's running instance has it under way. */
    running: integer({ mode: "boolean" }).notNull().default(false),
    /**
     * Whether the object stopped while it ran: until it settles it runs
     * alone, so a crash is put down to the item that caused it.
     */
    interrupted: integer({ mode: "boolean" }).notNull().default(false),
    /** When it was parked after too many failures; null while it may run. */
    parkedAt: integer("parked_at", { mode: "timestamp_ms" }),
    /** Why its last attempt failed: a code of the queue's (contract.ts `workErrors`). */
    lastError: text("last_error"),
  },
  // Each of the queue's lookups is one of these partial indexes; their
  // conditions are written as the queue's own SQL writes them (work.ts),
  // literals and not parameters, so SQLite can use them.
  (table) => [
    // What waits of a kind and key: one at most, replaced by a newer one.
    uniqueIndex("work_items_waiting_key")
      .on(table.kind, table.key)
      .where(sql.raw("running = 0")),
    // What runs: its keys, connections and whether it runs alone.
    index("work_items_running_idx")
      .on(table.kind, table.key, table.connection, table.interrupted)
      .where(sql.raw("running = 1")),
    // The next items to claim, by connection (none first), the first
    // first: a claim reads the first few of each, never the backlog of a
    // connection at its limit.
    index("work_items_waiting_idx")
      .on(table.connection, table.priority, table.id)
      .where(sql.raw("running = 0 AND parked_at IS NULL AND interrupted = 0")),
    // The interrupted ones, each to run alone first.
    index("work_items_interrupted_idx")
      .on(table.priority, table.id)
      .where(sql.raw("running = 0 AND parked_at IS NULL AND interrupted = 1")),
    // The parked ones, the latest first, for staff.
    index("work_items_parked_idx")
      .on(table.parkedAt, table.id)
      .where(sql.raw("parked_at IS NOT NULL")),
    check("work_items_priority", sql.raw("priority BETWEEN 0 AND 4")),
  ]
);

/**
 * The queue's one bucket of model calls (work.ts): its tokens and when
 * they were counted, in the queue's time; and the model's wait: until
 * when, since when there was no answer, and why. One row at most.
 */
export const workModelBucket = sqliteTable(
  "work_model_bucket",
  {
    id: integer().primaryKey(),
    tokens: real().notNull(),
    at: integer().notNull(),
    pausedUntil: integer("paused_until").notNull(),
    /** When the pause began, with no answer since; null once one came. */
    pausedSince: integer("paused_since"),
    pauseReason: text("pause_reason", {
      enum: ["rate_limited", "unavailable", "account"],
    }),
  },
  () => [check("work_model_bucket_one", sql.raw("id = 1"))]
);
