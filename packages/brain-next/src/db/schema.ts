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
    /**
     * When its producer read the text it added, if it said
     * (`NewSource.readAt`). A version's latest is when its text was last
     * read: no add of an earlier read replaces it (sources.ts
     * `newerThan`). Each change keeps its own, so a later read of the same
     * text, kept as a change of the version it matches, moves it on
     * without anything being overwritten.
     */
    readAt: integer("read_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    primaryKey({ columns: [table.source, table.change] }),
    // A version's changes, and the latest read of them, without a scan:
    // `newerThan` inside the store's write, and the export's latest read
    // and change keys of each version.
    index("source_changes_version_idx").on(table.versionRow, table.readAt),
  ]
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
    /**
     * The SHA-256 of its text, in hex: the key of its vectors in the
     * bucket (embedding.ts). Written with every chunk; a chunk without
     * one is never embedded.
     */
    hash: text(),
  },
  (table) => [
    unique("chunks_version_position_unique").on(
      table.versionRow,
      table.position
    ),
    // Whether a current chunk still holds a vector's text.
    index("chunks_hash_idx").on(table.hash),
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
    /**
     * The chunk whose code it was, so an erasure of the chunk's version
     * finds and repacks the block (erasure.ts). Added by migration 0006,
     * which cleared every vector table first, so every mark names it.
     */
    chunk: integer(),
  },
  (table) => [
    primaryKey({ columns: [table.block, table.slot] }),
    index("vector_removed_chunk_idx").on(table.chunk),
  ]
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
    /**
     * Never used twice, an item deleted included (migration 0006): an
     * erasure deletes the row of an item under way, and its handler's
     * settling, by this id, must never reach an item added after it.
     */
    id: integer().primaryKey({ autoIncrement: true }),
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

/**
 * The rules the word indexes (`chunk_words`, `chunk_stems`) were built
 * with (words.ts `wordsVersion`), and the rebuild under way when they
 * change: the rules it writes, and the last chunk it rewrote. One row; a
 * store whose `version` is behind rebuilds a batch a tick (words.ts
 * `reindexWords`).
 */
export const wordIndex = sqliteTable(
  "word_index",
  {
    id: integer().primaryKey(),
    /** The rules every chunk's words are indexed by. */
    version: integer().notNull(),
    /** The rules a rebuild under way writes. */
    target: integer().notNull(),
    /** The last chunk (`chunks.row`) the rebuild rewrote: 0 before the first. */
    cursor: integer().notNull(),
    /**
     * The last memory (`memories.row`) the rebuild rewrote, once past the
     * last chunk: 0 before the first. Added by migration 0008.
     */
    memoryCursor: integer("memory_cursor").notNull().default(0),
  },
  () => [check("word_index_one", sql.raw("id = 1"))]
);

// Erasure (erasure.ts). `erasures` keeps each erasure the store applied,
// by its key in the ledger in the Brain's bucket, and is how an erased
// source's key stays closed; `erasing_versions` the versions an erasure
// hid and the tick has still to delete; `erased_versions` what a person's
// erasure hid, kept for good; `source_subjects` each source's key as the
// ledger names it, so a replay finds a source by SQL.

/**
 * An erasure the store applied, as its ledger entry names it: no content
 * and no plain id. Recorded before its ledger entry is written, then
 * confirmed once the entry is in the bucket. Never deleted: it closes an
 * erased source's key, and the last one is where a replay of the ledger
 * starts.
 */
export const erasures = sqliteTable(
  "erasures",
  {
    /** Its key in the ledger (erasure.ts `ledgerKeyOf`). */
    key: text().primaryKey(),
    kind: text({ enum: ["source", "person"] }).notNull(),
    /** The SHA-256 of the source's key or the person's id, in hex. */
    subject: text().notNull(),
    /** Why (contract.ts `erasureReasons`). */
    reason: text().notNull(),
    erasedAt: integer("erased_at", { mode: "timestamp_ms" }).notNull(),
    /** Whether its ledger entry is known to be in the bucket, every part. */
    confirmed: integer({ mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    // An add looks up whether its source, or its one reader, was erased.
    index("erasures_subject_idx").on(table.kind, table.subject),
    // The tick confirms what isn't yet.
    index("erasures_unconfirmed_idx")
      .on(table.key)
      .where(sql.raw("confirmed = 0")),
    check("erasures_kind", sql`${table.kind} IN ('source', 'person')`),
  ]
);

/**
 * How far the store has come putting the current versions on the queue
 * for the host's embedding model (embedding.ts): the model as last seen
 * at a tick (`vectorModelNameOf`), null while the host ran none; the
 * last current version's row put on the queue for it; and whether every
 * one was. A change of model, or a re-embed staff start, begins again
 * from the first. One row at most.
 */
export const embeddingState = sqliteTable(
  "embedding_state",
  {
    id: integer().primaryKey(),
    model: text(),
    walkedTo: integer("walked_to").notNull(),
    walked: integer({ mode: "boolean" }).notNull(),
    /**
     * Whether the walk is over and every item it put on the queue has
     * settled: the rebuild for `model` is done (embedding.ts).
     */
    rebuilt: integer({ mode: "boolean" }).notNull(),
  },
  () => [check("embedding_state_one", sql.raw("id = 1"))]
);

/**
 * A passage's full vector in the bucket (embedding.ts), by its model and
 * its text's SHA-256, kept as `files` keeps original files: a row is
 * written before its object, so no object is ever in the bucket without
 * one, and the object is deleted only with its row, by the same sweep
 * (files.ts), past the same grace and doubt. `unheld` marks a row whose
 * text may no longer be in any current chunk, or whose object may not
 * have been wanted: the sweep checks again before it deletes.
 */
export const vectorFiles = sqliteTable(
  "vector_files",
  {
    model: text().notNull(),
    hash: text().notNull(),
    writtenAt: integer("written_at", { mode: "timestamp_ms" }).notNull(),
    inDoubtUntil: integer("in_doubt_until", { mode: "timestamp_ms" }),
    unheld: integer({ mode: "boolean" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.model, table.hash] }),
    // The rows of a text, whatever their model.
    index("vector_files_hash_idx").on(table.hash),
    // The sweep's candidates, the oldest first.
    index("vector_files_unheld_idx")
      .on(table.writtenAt)
      .where(sql.raw("unheld = 1")),
  ]
);

/**
 * A version an erasure hid, still to delete: found by nothing (recall,
 * history and current reads leave it out), deleted with everything it
 * holds by the tick (erasure.ts `eraseBatch`). One that failed to delete
 * goes behind the others, and is tried again.
 */
export const erasingVersions = sqliteTable(
  "erasing_versions",
  {
    versionRow: integer("version_row")
      .primaryKey()
      .references(() => sourceVersions.row),
    erasure: text()
      .notNull()
      .references(() => erasures.key),
    /** How often deleting it failed. */
    failures: integer().notNull().default(0),
  },
  (table) => [
    index("erasing_versions_erasure_idx").on(table.erasure),
    // A batch takes the next by failures, then by row.
    index("erasing_versions_next_idx").on(table.failures, table.versionRow),
  ]
);

/**
 * A source's key as the erasure ledger names it: its SHA-256, written
 * with the source's first version, so a replay finds the source the
 * ledger names in SQL, and a person's erasure names the sources it hid.
 * With it, the SHA-256 of the group it was added in (`NewSource.group`),
 * for good: null for a source in none. A group's erasure finds its
 * sources by it.
 */
export const sourceSubjects = sqliteTable(
  "source_subjects",
  {
    source: text().primaryKey(),
    subject: text().notNull(),
    group: text("group_subject"),
  },
  (table) => [
    index("source_subjects_subject_idx").on(table.subject),
    index("source_subjects_group_idx").on(table.group),
  ]
);

/**
 * The SHA-256 of every key an add named as its group (`NewSource.group`),
 * kept for good, as the erasure ledger names keys: so once such a key is
 * erased, every key under it (`<group>/…`) stays refused, whether an add
 * names the group or not (sources.ts). A key no add ever named as a group
 * is none: erasing it closes it alone.
 */
export const knownGroups = sqliteTable("known_groups", {
  subject: text().primaryKey(),
});

/**
 * What a person's erasure hid, a row a version: by number under the
 * SHA-256 of its source's key, as its ledger entry holds it (erasure.ts),
 * kept after the version is deleted, so the entry can be written again
 * whole, part by part, however many versions it names. A source's erasure
 * has none: it hides every version of its source. Kept for good, as the
 * erasure's own record, costing storage only: they hold nothing but
 * hashes and version numbers.
 */
export const erasedVersions = sqliteTable(
  "erased_versions",
  {
    erasure: text()
      .notNull()
      .references(() => erasures.key),
    /** The SHA-256 of the source's key, in hex. */
    subject: text().notNull(),
    version: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.erasure, table.subject, table.version] }),
    // An add numbers a source's next version past every one erased.
    index("erased_versions_subject_idx").on(table.subject, table.version),
  ]
);

/**
 * A passage the host's model can't embed (embedding.ts), by its model and
 * its text's SHA-256: the embedder's own answer for that text. Passed
 * over for that model, so the rest of its source goes on; cleared by a
 * re-embed, and every other build tries it afresh.
 */
export const unembeddable = sqliteTable(
  "unembeddable",
  {
    model: text().notNull(),
    hash: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.model, table.hash] })]
);

// Exports and restores (exports.ts, restore.ts). An export writes what a
// scope holds as files in the store's part of the bucket (`exports/<id>/`),
// a part a run of the queue, and its manifest last; a restore reads a
// company export's files back into an empty shared store.

/**
 * An export of the company's Brain, and how far it has come. It is stale once the erasure ledger names a
 * version it holds (`export_sources`), and its files are deleted
 * (exports.ts).
 */
export const exportsTable = sqliteTable(
  "exports",
  {
    id: text().primaryKey(),
    /** The deployment it is of, as the host names it: its manifest says so. */
    deployment: text().notNull(),
    /** The last version's row it takes: what was there when it started. */
    upTo: integer("up_to").notNull(),
    /**
     * The last row written to a part, of the table its step reads
     * (`phase`): a version's, then a memory's, a confirmation's, an
     * extraction mark's, a change's (exports.ts `memoryPhases`).
     */
    cursor: integer().notNull(),
    /** The step being written: null for versions, then each of `memoryPhases` by its number. */
    phase: integer(),
    /**
     * The store's latest write stamp of memories as it started
     * (`memory_stamps`): it takes only what was learned by then, and its
     * manifest carries it, so a restore never lowers the store's.
     */
    stamp: integer(),
    /** The last change of memories' row (`memory_changes.rowid`) it takes. */
    changesUpTo: integer("changes_up_to"),
    state: text({
      enum: ["writing", "restoring", "done", "failed", "erased", "expired"],
    }).notNull(),
    /** Parts written, and the versions in them. */
    parts: integer().notNull(),
    versions: integer().notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("exports_state_idx").on(table.state, table.finishedAt)]
);

/**
 * The versions an export holds, by their source's key as the erasure
 * ledger names it (SHA-256) and their number: recorded with each part, so
 * the ledger naming one of them makes exactly the exports that hold it
 * stale. Kept until the export's files are deleted, so an erasure is
 * known unfinished while a file still holds what it took.
 */
export const exportSources = sqliteTable(
  "export_sources",
  {
    export: text()
      .notNull()
      .references(() => exportsTable.id),
    subject: text().notNull(),
    version: integer().notNull(),
    /**
     * Whether a part of the export as written holds this version (exports.ts
     * `writePart`): recorded ahead of a part, a version is only held once
     * the part is. What its memories may rest on.
     */
    written: integer({ mode: "boolean" }),
  },
  (table) => [
    primaryKey({ columns: [table.export, table.subject, table.version] }),
    // An erasure finds the exports holding what it names.
    index("export_sources_subject_idx").on(table.subject, table.version),
  ]
);

/** A part of an export, as written: its SHA-256 and how many versions it holds. */
export const exportParts = sqliteTable(
  "export_parts",
  {
    export: text()
      .notNull()
      .references(() => exportsTable.id),
    part: integer().notNull(),
    hash: text().notNull(),
    versions: integer().notNull(),
    /** Lines of memories it holds (exports.ts `memoryPhases`): null for none. */
    memories: integer(),
    /** Its size in bytes, as written. */
    bytes: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.export, table.part] })]
);

/**
 * A restore of a company export into the shared store: how far it has
 * checked and written its export's parts (each part's hash, size and count
 * are rows of `export_parts`, written as it started, so no value grows
 * with how many parts there are), and how many versions it restored.
 */
export const restores = sqliteTable("restores", {
  export: text().primaryKey(),
  /** Parts checked so far, in a first pass before anything is written. */
  checked: integer().notNull(),
  /** Whether a part checked so far failed: the restore fails once all are checked. */
  damaged: integer({ mode: "boolean" }).notNull().default(false),
  /**
   * When it failed: the last version's row the store held then. A restart
   * is refused once anything was added past it.
   */
  heldTo: integer("held_to"),
  /**
   * When it failed: the store's latest write stamp of memories then. A
   * restart is refused once any write of memories moved it.
   */
  heldStamp: integer("held_stamp"),
  /** The next part to write, once every part is checked. */
  part: integer().notNull(),
  restored: integer().notNull(),
  state: text({ enum: ["running", "done", "failed", "abandoned"] }).notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
});

/**
 * The sweep of export files the store has no record of (exports.ts
 * `sweepWork`): the last erasure (`erasures.rowid`) its pass was started
 * for, and where its listing of `exports/` goes on (null once it is
 * through), saved after each key; and the last erasure every export was
 * checked against. One row at most. A store whose rows were lost, or
 * rolled back, replays its ledger into `erasures` past both, so both are
 * due again.
 */
export const exportSweep = sqliteTable(
  "export_sweep",
  {
    id: integer().primaryKey(),
    through: integer().notNull(),
    /** The last erasure every export was checked against (`staleSql`). */
    checked: integer().notNull().default(0),
    cursor: text(),
  },
  () => [check("export_sweep_one", sql.raw("id = 1"))]
);

// Memories and entities (memories.ts, entities.ts). A memory is written
// once and never changed but for the moment it is retired: what ends it
// otherwise is a newer memory of its lineage, read as such per reader, so
// nothing about an older memory is written over. Its readers are its set
// (`reader_set`, as the caller gave it) and, when it rests on a source
// version, that version's and the source's current version's: checked in
// every statement that reads it.

/** A thing memories are about, with the store's own id for it. */
export const entities = sqliteTable(
  "entities",
  {
    row: integer().primaryKey({ autoIncrement: true }),
    /** Its id, as readers and callers name it. */
    id: text().notNull().unique(),
    kind: text().notNull(),
  },
  (table) => [index("entities_kind_idx").on(table.kind, table.row)]
);

/**
 * A memory (contract.ts `Memory`). Its lineage is the source it rests on
 * (`source:` and the source's key) or its writer (`writer:` and their
 * id); `lineage_order` orders a lineage's memories, the version number
 * for a source's, 0 for a writer's, then `row`. `value_key` is what
 * one-value attributes compare: the value folded, or the related entity's
 * id.
 */
export const memories = sqliteTable(
  "memories",
  {
    row: integer().primaryKey({ autoIncrement: true }),
    id: text().notNull().unique(),
    entity: integer()
      .notNull()
      .references(() => entities.row),
    attribute: text(),
    object: integer().references(() => entities.row),
    value: text(),
    valueKey: text("value_key"),
    oneValue: integer("one_value", { mode: "boolean" }).notNull(),
    type: text().notNull(),
    statement: text().notNull(),
    quote: text(),
    // The version it rests on, by its source's key and its number, and
    // its readers, by their set's key (`reader_sets.key`): never by a
    // row id, which a release before memories may delete (an admin's
    // rollback) and SQLite then give to another version or group. A
    // memory whose version or set is gone is read by no one and deleted
    // when the store starts if an erasure covered it (erasure.ts
    // `replayMemoryErasures`); a set an older release dropped is made
    // again from its key.
    source: text(),
    version: integer(),
    /**
     * The SHA-256 of `source`, as the erasure ledger names it: how a
     * replay of the store's erasures at start finds what they covered
     * (erasure.ts `replayMemoryErasures`).
     */
    subject: text(),
    writer: text(),
    lineage: text().notNull(),
    lineageOrder: integer("lineage_order").notNull(),
    /** Whose word it is, as JSON (contract.ts `Speaker`). */
    speaker: text().notNull(),
    validFrom: integer("valid_from"),
    validUntil: integer("valid_until"),
    learnedAt: integer("learned_at").notNull(),
    retiredAt: integer("retired_at"),
    readers: text().notNull(),
  },
  (table) => [
    index("memories_entity_idx").on(
      table.entity,
      table.attribute,
      table.lineage
    ),
    index("memories_object_idx").on(table.object),
    index("memories_version_idx").on(table.source, table.version),
    index("memories_subject_idx").on(table.subject, table.version),
    index("memories_readers_idx").on(table.readers),
  ]
);

/**
 * A name or an exact identifier of an entity, as one memory gave it:
 * visible only to those who may read that memory, and gone with it.
 * `folded` is what a find compares: the name folded as search folds
 * words, an email lowercased, a reference as written.
 */
export const entityNames = sqliteTable(
  "entity_names",
  {
    entity: integer()
      .notNull()
      .references(() => entities.row),
    memory: integer()
      .notNull()
      .references(() => memories.row),
    type: text({ enum: ["name", "email", "ref"] }).notNull(),
    value: text().notNull(),
    folded: text().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.entity, table.memory, table.type, table.folded],
    }),
    index("entity_names_folded_idx").on(table.type, table.folded, table.entity),
    index("entity_names_memory_idx").on(table.memory),
  ]
);

/**
 * A person's confirmation of a memory, as their own word, over the
 * memories (`memory_confirmed_over`) that said something else then: seen
 * only by readers who may read the memory and each of those.
 */
export const memoryConfirmations = sqliteTable(
  "memory_confirmations",
  {
    row: integer().primaryKey({ autoIncrement: true }),
    memory: integer()
      .notNull()
      .references(() => memories.row),
    person: text().notNull(),
    at: integer().notNull(),
  },
  (table) => [index("memory_confirmations_memory_idx").on(table.memory)]
);

/** A memory a confirmation was made over. */
export const memoryConfirmedOver = sqliteTable(
  "memory_confirmed_over",
  {
    confirmation: integer()
      .notNull()
      .references(() => memoryConfirmations.row),
    memory: integer()
      .notNull()
      .references(() => memories.row),
  },
  (table) => [
    primaryKey({ columns: [table.confirmation, table.memory] }),
    index("memory_confirmed_over_memory_idx").on(table.memory),
  ]
);

/**
 * A version of a source fully extracted (contract.ts `extracted`): every
 * memory of its source's lineage from an earlier version ends at `at`,
 * for readers of both the add that marked it and this version. Deleted
 * with the version.
 */
export const memoryExtractions = sqliteTable(
  "memory_extractions",
  {
    source: text().notNull(),
    version: integer().notNull(),
    /** The SHA-256 of `source`, as `memories.subject`. */
    subject: text().notNull(),
    lineage: text().notNull(),
    at: integer().notNull(),
    /** The add's readers, by their set's key: only they, of the version's, see it end what came before. */
    readers: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.source, table.version, table.readers] }),
    index("memory_extractions_lineage_idx").on(table.lineage, table.version),
    index("memory_extractions_readers_idx").on(table.readers),
    index("memory_extractions_subject_idx").on(table.subject, table.version),
  ]
);

/**
 * An add of memories, by the SHA-256 of its change key (no plain key is
 * kept), with the SHA-256 of what it added and what it answered (ids
 * only): the same change again answers the same.
 */
export const memoryChanges = sqliteTable("memory_changes", {
  key: text().primaryKey(),
  hash: text().notNull(),
  answer: text().notNull(),
});

/**
 * How far the start-up replay of erasures on memories has come (erasure.ts
 * `replayMemoryErasures`): the highest `erasures` rowid it applied. One
 * row. A table older releases do not know, so an erasure one records
 * after a rollback is above it, and replayed after the roll forward; a
 * restore brings the mark back with its copy.
 */
export const memoryErasureReplay = sqliteTable(
  "memory_erasure_replay",
  {
    id: integer().primaryKey(),
    through: integer().notNull(),
  },
  () => [check("memory_erasure_replay_one", sql.raw("id = 1"))]
);

/**
 * The latest moment the store stamped a write of memories with (memories.ts
 * `stampWrite`): every later write is stamped after it, and a read is
 * given no moment before it. One row; never lowered, a deletion included.
 */
export const memoryStamps = sqliteTable(
  "memory_stamps",
  {
    id: integer().primaryKey(),
    latest: integer().notNull(),
  },
  () => [check("memory_stamps_one", sql.raw("id = 1"))]
);
