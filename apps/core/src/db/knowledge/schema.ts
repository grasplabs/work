/**
 * Knowledge D1 database: collections, documents, versions (compact
 * metadata: each one's text is an immutable payload in R2, see
 * `brainPayloads`), sections, links and the full-text index (unicode61 plus
 * trigram).
 *
 * Versions keep every text a document ever had, but for what a purge
 * removed (knowledge/purge.ts). Sections and links are those of the
 * current version only, replaced on each save and purge: they are what
 * search indexes and agents read and follow, and an earlier version's are
 * derived from its text again when needed.
 *
 * The full-text index (`search_rows`, `search_words`, `search_trigrams` and
 * the triggers that keep them) is FTS5, which Drizzle can't describe: it
 * lives in its own migrations: `0001_search.sql`, and
 * `0017_search_one_content.sql`, where the trigram index reads the words
 * index's content rather than keeping a copy of it.
 */
import type { Json } from "@grasp-os/shared/json";
import { knowledgeSignalKinds } from "@grasp-os/shared/knowledge-signals";
import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// The outbox of audit events for changes to this database, and the rows
// moved out of it, with the same shape as the core database's (see
// src/audit-outbox.ts).
export { auditOutbox, auditOutboxRejected } from "../core/schema.ts";

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

/**
 * The oldest migration whose code still runs on this database's schema,
 * which each release declares (scripts/release): the console won't put
 * the code of a release whose newest migration is older on it, by a
 * rollback or a deploy.
 *
 * Migrations expand, then contract in a later release (AGENTS.md), so the
 * code of the release before keeps working on a new schema, and a
 * migration that only expands leaves this where it is. One that drops or
 * renames what older code still uses raises it: to the migration of the
 * first release whose code no longer used it, or, when the code stopped
 * in the same release, to that migration's own number.
 *
 * 0015 replaced `versions` (each one's text moved to R2) in the release
 * that stopped writing the old one.
 */
export const compatibleFromMigration = 15;

/**
 * A set of documents with one owner, access rule and source. Indexed by
 * access and by owner, so listing the collections a reader may read
 * (knowledge/access.ts) reaches them by index, never the whole table.
 */
export const collections = sqliteTable(
  "collections",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    description: text().notNull(),
    /** User ID. */
    owner: text().notNull(),
    access: text({ enum: ["everyone", "teams", "me", "admins"] }).notNull(),
    sensitive: integer({ mode: "boolean" }).notNull().default(false),
    source: text({
      enum: ["here", "upload", "grasp", "apps"],
    }).notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    index("collections_access_idx").on(table.access),
    index("collections_owner_idx").on(table.owner),
  ]
);

/** The teams that may read a `teams` collection. */
export const collectionTeams = sqliteTable(
  "collection_teams",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    /** A team in the core database. */
    teamId: text("team_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.collectionId, table.teamId] }),
    index("collection_teams_team_id_idx").on(table.teamId),
  ]
);

/**
 * A document: its place, and what its current version's frontmatter says,
 * so listings don't parse any text.
 */
export const documents = sqliteTable(
  "documents",
  {
    id: text().primaryKey(),
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    path: text().notNull(),
    title: text().notNull(),
    type: text().notNull(),
    description: text().notNull(),
    owner: text().notNull(),
    /** JSON array of strings. */
    tags: text().notNull(),
    /** `YYYY-MM-DD`. */
    reviewDate: text("review_date"),
    currentVersion: integer("current_version").notNull(),
    /**
     * The version whose sections search holds (knowledge/indexing.ts):
     * the current one once indexed, an older one while it catches up.
     */
    indexedVersion: integer("indexed_version"),
    /**
     * Where indexing the current version stands: set `queued` by the save
     * that makes it current, in the same batch, so the save is its durable
     * intent; `indexed` by the batch that publishes its sections.
     */
    indexState: text("index_state", {
      enum: ["queued", "retrying", "indexed", "failed"],
    })
      .notNull()
      .default("queued"),
    /** Failed attempts at indexing the current version. */
    indexAttempts: integer("index_attempts").notNull().default(0),
    /** The code of the error indexing the current version last failed with. */
    indexFailure: text("index_failure"),
    /**
     * Which run indexes the current version: 0 for the first, one more for
     * each the cron trigger starts again after the one before failed.
     */
    indexRun: integer("index_run").notNull().default(0),
    /** When indexing the current version last failed for good. */
    indexFailedAt: timestamp("index_failed_at"),
    /**
     * Set when a purge couldn't wait for indexing: search may still hold
     * a generation with what it removed, so its runs are started again for
     * as long as it takes. Cleared once indexed.
     */
    indexPurgePending: integer("index_purge_pending", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    // The repair sweep, and search's coverage, find what isn't indexed.
    index("documents_index_state_idx").on(table.indexState, table.updatedAt),
    uniqueIndex("documents_collection_path_idx").on(
      table.collectionId,
      table.path
    ),
    // The daily usage signals (knowledge/signals.ts) page through the
    // documents unchanged for long, and those past their review date.
    index("documents_updated_at_idx").on(table.updatedAt, table.id),
    index("documents_review_date_idx")
      .on(table.reviewDate, table.id)
      .where(sql`${table.reviewDate} IS NOT NULL`),
  ]
);

/**
 * The texts of versions, each an immutable object in the `BRAIN_OBJECTS`
 * bucket under `key` (knowledge/payloads.ts), written once and never
 * replaced. A row is `pending` from before its object is put until the
 * batch that first refers to it marks it `committed`; at most one row per
 * collection and hash is committed, so identical texts in a collection
 * share one object. Never across collections: how fast a save is would
 * otherwise tell its writer whether a text exists where they can't read. Collecting an
 * unreferenced one marks it `collecting` first, which no save takes again,
 * then deletes its object, then the row.
 */
export const brainPayloads = sqliteTable(
  "brain_payloads",
  {
    /** The object's key in R2: core's own, never handed out. */
    key: text().primaryKey(),
    /** The collection whose documents' versions it may hold. */
    collectionId: text("collection_id").notNull(),
    /** The text's SHA-256, in hex, which every read checks again. */
    sha256: text().notNull(),
    /** The text's size, in bytes of UTF-8. */
    bytes: integer().notNull(),
    /**
     * `broken`: committed, but its object turned out missing or not its
     * text (knowledge/payloads.ts). Never taken by a save again; collected
     * once no version refers to it.
     */
    state: text({
      enum: ["pending", "committed", "broken", "collecting"],
    }).notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("brain_payloads_committed_sha256_idx")
      .on(table.collectionId, table.sha256)
      .where(sql`${table.state} = 'committed'`),
    index("brain_payloads_state_idx").on(table.state, table.createdAt),
  ]
);

/**
 * Payloads that versions about to be deleted or pointed elsewhere refer
 * to, noted earlier in the same batch: its end marks those no version
 * refers to any more `collecting`, and clears the table
 * (knowledge/payloads.ts). Empty between batches.
 */
export const brainPayloadReleases = sqliteTable("brain_payload_releases", {
  key: text().primaryKey(),
});

/**
 * Every version of every document, its text a payload (`brainPayloads`),
 * which only a purge points elsewhere. The primary key is also the edit
 * check: two saves from the same version both write the next number, and
 * the second one fails.
 */
export const versions = sqliteTable(
  "versions",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    number: integer().notNull(),
    /** Its text: a committed payload when written (knowledge/payloads.ts). */
    payloadKey: text("payload_key")
      .notNull()
      .references(() => brainPayloads.key),
    /** User ID. */
    author: text().notNull(),
    message: text(),
    /** The version this one restored. */
    restoredFrom: integer("restored_from"),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.documentId, table.number] }),
    // Collecting a payload asks whether any version still refers to it.
    index("versions_payload_key_idx").on(table.payloadKey),
  ]
);

/**
 * The sections search holds of each document: those of its indexed version
 * (`documents.indexed_version`), split by heading, in order, replaced
 * whole by each published generation (knowledge/indexing.ts).
 */
export const sections = sqliteTable(
  "sections",
  {
    documentId: text("document_id").notNull(),
    version: integer().notNull(),
    position: integer().notNull(),
    /** JSON array: the headings above and of this section, outermost first. */
    headings: text().notNull(),
    text: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.documentId, table.position] }),
    foreignKey({
      columns: [table.documentId, table.version],
      foreignColumns: [versions.documentId, versions.number],
    }).onDelete("cascade"),
  ]
);

/**
 * The current version's `[[links]]`, by the path they name, so a link to a
 * document that doesn't exist yet finds it once it does.
 */
export const links = sqliteTable(
  "links",
  {
    fromDocumentId: text("from_document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    toCollectionId: text("to_collection_id").notNull(),
    toPath: text("to_path").notNull(),
    label: text(),
  },
  (table) => [
    primaryKey({
      columns: [table.fromDocumentId, table.toCollectionId, table.toPath],
    }),
    index("links_to_idx").on(table.toCollectionId, table.toPath),
  ]
);

/**
 * Which version of each App its entry in the Apps collection holds
 * (knowledge/apps-collection.ts): written in the same batch as the entry,
 * so it never names a version the entry doesn't have. An App whose current
 * version differs, or that has no row, is indexed again.
 */
export const appEntries = sqliteTable("app_entries", {
  /** An App in the core database. */
  appId: text("app_id").primaryKey(),
  version: integer().notNull(),
  indexedAt: timestamp("indexed_at").notNull(),
});

/**
 * A file uploaded into a collection (knowledge/uploads.ts): its original,
 * kept in R2 under its hash, and where extracting its text into the
 * document at `path` stands. Only the person who uploaded it sees it.
 */
export const uploads = sqliteTable(
  "uploads",
  {
    id: text().primaryKey(),
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    /** The file's name, and the path of its document. */
    path: text().notNull(),
    mediaType: text("media_type").notNull(),
    /** The file's size. */
    bytes: integer().notNull(),
    /** The file's SHA-256, in hex, which R2 checks the original against. */
    sha256: text().notNull(),
    /** User ID. */
    uploadedBy: text("uploaded_by").notNull(),
    /** JSON: the audit log's actor for the person who uploaded it. */
    actor: text().notNull(),
    status: text({
      enum: ["pending", "extracting", "ready", "failed"],
    }).notNull(),
    /** The code of the error it failed with. */
    failure: text(),
    /** The document and version it was saved as, once ready. */
    documentId: text("document_id"),
    version: integer(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    index("uploads_path_idx").on(
      table.collectionId,
      table.path,
      table.createdAt
    ),
    index("uploads_original_idx").on(table.collectionId, table.sha256),
    index("uploads_status_idx").on(table.status, table.updatedAt),
  ]
);

/**
 * Originals to delete from R2 (knowledge/uploads.ts), by key: recorded
 * with the upload, before its original is stored, and cleared once it is
 * saved; recorded again by a purge. Deleted by the failure that makes one
 * unneeded, or by the cron trigger once its upload is gone or failed.
 */
export const uploadCleanups = sqliteTable("upload_cleanups", {
  /** The original's key in R2. */
  key: text().primaryKey(),
  /** The upload whose original it is. */
  uploadId: text("upload_id").notNull(),
  /**
   * When its original may have been written, at the latest: the upload's
   * creation, or 0 for one known to be written already.
   */
  createdAt: timestamp("created_at").notNull(),
});

/**
 * Rebuilds of the full-text index a content purge needs and hasn't
 * finished (knowledge/search-erasure.ts): recorded with the purge's audit
 * event, before anything changes, when a term was part of a longer token
 * the purge's own check can't find; marked once the purge's writes are
 * done, and cleared by a rebuild that ran after that. Run again, a purge
 * whose text is rewritten already still rebuilds.
 */
export const searchRebuilds = sqliteTable("search_rebuilds", {
  /** The purge's own: it marks its writes done by it. */
  id: text().primaryKey(),
  /** When the purge that needs it recorded it, ms. */
  owedAt: integer("owed_at").notNull(),
  /** When the purge's writes were done, ms; null while they may not be. */
  writesDoneAt: integer("writes_done_at"),
});

/**
 * The daily computations of the usage signals (knowledge/signals.ts), one
 * row per attempt, as core's `improvement_signal_computations` has them
 * (src/daily-claims.ts).
 */
export const knowledgeSignalComputations = sqliteTable(
  "knowledge_signal_computations",
  {
    id: text().primaryKey(),
    /** The UTC day it is the computation of, such as `2026-09-29`. */
    day: text().notNull(),
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    index("knowledge_signal_computations_day_idx").on(table.day),
    index("knowledge_signal_computations_started_idx").on(
      table.startedAt,
      table.id
    ),
  ]
);

/**
 * The usage signals of a computation: one per kind, collection and subject
 * (a search's key, or a document's ID), for the collection's owner, with
 * an ID derived from those three, the same in every computation. Readers
 * take only the finished computation started last, so a computation's
 * signals show all at once when it finishes, and never those of one that
 * doesn't. Written under the computation's ID: one that outlived its lease
 * and lost its row fails on the foreign key. `evidence` is JSON, IDs and
 * counts only; `evidence_at` is when its latest evidence was seen (a
 * question's latest search), null for a document's.
 *
 * No foreign keys to collections or documents: a purge that deletes one
 * meanwhile must not fail a computation's writes. Reads join the
 * collection (and the document) and so never show a signal about one
 * that's gone.
 */
export const knowledgeSignals = sqliteTable(
  "knowledge_signals",
  {
    computation: text()
      .notNull()
      .references(() => knowledgeSignalComputations.id),
    id: text().notNull(),
    kind: text({ enum: knowledgeSignalKinds }).notNull(),
    collectionId: text("collection_id").notNull(),
    subject: text().notNull(),
    /** User ID: the collection's owner when it was computed. */
    owner: text().notNull(),
    /**
     * Ranks it within its kind: a question's searches, the days since an
     * unread document changed. Null for an overdue document, ranked by its
     * review date as it is when listed.
     */
    value: integer(),
    evidence: text({ mode: "json" }).$type<Json>().notNull(),
    evidenceAt: timestamp("evidence_at"),
  },
  (table) => [
    primaryKey({ columns: [table.computation, table.id] }),
    uniqueIndex("knowledge_signals_subject_idx").on(
      table.computation,
      table.collectionId,
      table.kind,
      table.subject
    ),
    index("knowledge_signals_owner_idx").on(
      table.computation,
      table.owner,
      table.kind,
      table.value,
      table.id
    ),
  ]
);

/**
 * Signals an owner dismissed, by kind, collection and subject, so they
 * outlast the computations: a signal is hidden while it has no evidence
 * newer than its dismissal. A computation's finish removes those whose
 * signal it no longer has, or has with newer evidence, so a signal that
 * went away and came back shows again.
 */
export const knowledgeSignalDismissals = sqliteTable(
  "knowledge_signal_dismissals",
  {
    kind: text({ enum: knowledgeSignalKinds }).notNull(),
    collectionId: text("collection_id").notNull(),
    subject: text().notNull(),
    dismissedAt: timestamp("dismissed_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.collectionId, table.subject] }),
  ]
);

/**
 * The Brain's memory records (knowledge/memories.ts): what a person, or
 * later an App or agent acting for one, asked the Brain to remember, as
 * they said it. A record starts `proposed`, never an accepted fact.
 * Its scope decides who reads it; `owner_id` is the person whose it is.
 */
export const brainMemories = sqliteTable(
  "brain_memories",
  {
    id: text().primaryKey(),
    revision: integer().notNull(),
    scope: text({ enum: ["person", "session", "team", "company"] }).notNull(),
    /** User ID of the person whose record it is. */
    ownerId: text("owner_id").notNull(),
    kind: text({
      enum: ["fact", "experience", "lesson", "preference"],
    }).notNull(),
    statement: text().notNull(),
    /** JSON array of the Brain's source references (brain-api.ts). */
    sourceRefs: text("source_refs").notNull(),
    state: text({ enum: ["proposed", "accepted", "retired"] }).notNull(),
    /** Whether search has it yet: written `pending` with the record. */
    indexingState: text("indexing_state", {
      enum: ["pending", "indexed", "failed"],
    }).notNull(),
    recordedAt: timestamp("recorded_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    // A person's records, newest first, of one kind or all, paged by
    // `(recorded_at, id)` (memories.ts): each index ends in the cursor's
    // order, so a page is a range scan. The first also serves a personal
    // purge's delete by owner.
    index("brain_memories_owner_idx").on(
      table.ownerId,
      table.recordedAt,
      table.id
    ),
    index("brain_memories_owner_kind_idx").on(
      table.ownerId,
      table.kind,
      table.recordedAt,
      table.id
    ),
  ]
);

/**
 * The Brain's command receipts: one per command key, so a retry after a
 * lost reply answers the recorded result. `key_hash` is the key keyed to
 * the deployment and scoped to the caller and operation, never the key
 * itself; `request_hash` is the validated request's, never its text.
 */
export const brainReceipts = sqliteTable(
  "brain_receipts",
  {
    id: text().primaryKey(),
    keyHash: text("key_hash").notNull(),
    /** Who may read it back: the same caller, as `callerKey` names it. */
    caller: text().notNull(),
    operation: text({ enum: ["remember", "memories.proposeChange"] }).notNull(),
    requestHash: text("request_hash").notNull(),
    status: text({
      enum: ["committed", "proposed", "queued", "completed", "failed"],
    }).notNull(),
    indexingState: text("indexing_state", {
      enum: ["pending", "indexed", "failed"],
    }).notNull(),
    /** JSON array of the Brain's source references it committed. */
    resourceRefs: text("resource_refs").notNull(),
    createdAt: timestamp("created_at").notNull(),
    retentionUntil: timestamp("retention_until").notNull(),
  },
  (table) => [
    uniqueIndex("brain_receipts_key_idx").on(table.keyHash),
    // The clock's sweep of expired receipts (`sweepBrainReceipts`).
    index("brain_receipts_retention_idx").on(table.retentionUntil),
    // A caller's recent commands, for the per-person bound on remember,
    // and a personal purge's delete by caller.
    index("brain_receipts_caller_idx").on(table.caller, table.createdAt),
  ]
);
