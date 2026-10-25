/**
 * The Brain's D1 database, all of it its own: collections, documents,
 * versions (compact metadata: each one's text is an immutable payload in
 * the host's bucket, see `brainPayloads`), sections, links, the full-text
 * index (unicode61 plus trigram), memories and receipts, and the outbox of
 * its audit events.
 *
 * Versions keep every text a document ever had, but for what a purge
 * removed (purge.ts). Sections and links are those of the
 * current version only, replaced on each save and purge: they are what
 * search indexes and agents read and follow, and an earlier version's are
 * derived from its text again when needed.
 *
 * The full-text index (`search_rows`, `search_words`, `search_trigrams` and
 * the triggers that keep them) is FTS5, which Drizzle can't describe: it
 * is the end of `0000_brain.sql`, written by hand, where the trigram index
 * reads the words index's content rather than keeping a copy of it.
 */
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

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

/**
 * The oldest migration whose code still runs on this database's schema,
 * which each release declares (scripts/release): the admin won't put
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
 * The migrations were squashed into one (0000_brain.sql) in a hard cut:
 * every database runs from it.
 */
export const compatibleFromMigration = 0;

/**
 * Audit events of changes to this database that haven't reached the
 * host's audit log yet. Each is written in the same batch as its change
 * (audit.ts), as the host's `audit.eventOf` port made it, so a change is
 * never kept without its event; the host drains them into its log and
 * removes them. `event` is the event as JSON.
 */
export const auditOutbox = sqliteTable("audit_outbox", {
  id: text().primaryKey(),
  event: text().notNull(),
  createdAt: timestamp("created_at").notNull(),
});

/**
 * Outbox rows the host's drain moved out because its log can't take
 * them, kept as they were, for someone to look at: `reason` says why, in
 * the host's words.
 */
export const auditOutboxRejected = sqliteTable(
  "audit_outbox_rejected",
  {
    // Its own key, so a second row with the same event ID is kept too.
    seq: integer().primaryKey(),
    id: text().notNull(),
    event: text().notNull(),
    reason: text().notNull(),
    /** When the row was stored in the outbox. */
    createdAt: timestamp("created_at").notNull(),
    rejectedAt: timestamp("rejected_at").notNull(),
  },
  (table) => [index("audit_outbox_rejected_id").on(table.id)]
);

/**
 * A set of documents with one owner, access rule and source. Indexed by
 * access and by owner, so listing the collections a reader may read
 * (the host's `authorize` port) reaches them by index, never the whole table.
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
     * The version whose sections search holds (../indexing.ts):
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
    // For paging through the documents unchanged for long, and those past
    // their review date (a host's usage signals, such as core's).
    index("documents_updated_at_idx").on(table.updatedAt, table.id),
    index("documents_review_date_idx")
      .on(table.reviewDate, table.id)
      .where(sql`${table.reviewDate} IS NOT NULL`),
  ]
);

/**
 * The texts of versions, each an immutable object in the `BRAIN_OBJECTS`
 * bucket under `key` (../payloads.ts), written once and never
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
     * text (../payloads.ts). Never taken by a save again; collected
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
 * (../payloads.ts). Empty between batches.
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
    /** Its text: a committed payload when written (../payloads.ts). */
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
 * whole by each published generation (../indexing.ts).
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
 * A document's transcript (../transcripts.ts): its turns and chapters, as
 * the producer that saved the version gave them, written in the batch of
 * that version and of no other, so it is always the version's own. Any
 * later save without one deletes it; a content purge rewrites it with
 * the version's text (../purge.ts). One row per document, so a purge has
 * one copy to reach. Turns get no search index of their own: they are
 * found as the text the producer saved with them.
 */
export const transcripts = sqliteTable(
  "transcripts",
  {
    documentId: text("document_id").primaryKey(),
    /** The version it was saved with: the document's current one. */
    version: integer().notNull(),
    /** JSON array of turns: `{ speaker, text, startMs?, endMs? }`. */
    turns: text().notNull(),
    /** JSON array of chapters: `{ title, firstTurn, lastTurn }`. */
    chapters: text().notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
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
 * Rebuilds of the full-text index a content purge needs and hasn't
 * finished (../search-erasure.ts): recorded with the purge's audit
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
 * The Brain's memory records (../memories.ts): what a person, or
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
    /**
     * Whose scope the record is in (GRA-298): its owner's user ID for
     * `person`, a team's ID for `team`, a chat's ID for `session`, none for
     * `company`. A read takes the scope keys the host compiled for its
     * audience; the Brain never takes a scope from a caller.
     */
    scopeId: text("scope_id"),
  },
  (table) => [
    // The records of a scope, newest first: what a turn's memory reads,
    // one scope key at a time (memories.ts, `memoriesFor`).
    index("brain_memories_scope_idx").on(
      table.scope,
      table.scopeId,
      table.recordedAt
    ),
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
    operation: text({
      enum: [
        "remember",
        "memories.proposeChange",
        "memories.publish",
        "memories.retire",
      ],
    }).notNull(),
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

/**
 * Settled task outcomes a host recorded through its runtime API
 * (../outcomes.ts `recordOutcome`): one row per learning event, its ID the
 * host's, derived from what settled, so a delivery made twice is one row.
 * Identifiers and states only, never what the task read, wrote or said:
 * `evidence_refs` point at the host's own execution records, which stay
 * where they are, and `evidence_id` names the one whose erasure erases
 * the event (`eraseOutcomes`). Only production work is kept: the runtime
 * API refuses evaluation, test and learning-job events.
 */
export const brainEpisodes = sqliteTable(
  "brain_episodes",
  {
    /** The host's event ID. */
    id: text().primaryKey(),
    /** The host's boundary the event settled at, such as `workflow.run`. */
    source: text().notNull(),
    /** The host's sequence of the event's capture on `source`. */
    sourceSeq: integer("source_seq").notNull(),
    /** User ID of the person whose experience it is. */
    ownerId: text("owner_id").notNull(),
    /** Who may learn from it, as the host set it. */
    scope: text({ enum: ["person", "session", "team", "company"] }).notNull(),
    /**
     * For a `session` event, the host's audience it is for (a chat others
     * share), whose members at the time are `brain_episode_members`: a
     * reader reaches it only while among both (../outcomes.ts).
     */
    audience: text(),
    /** The host's name for the kind of task, such as an App's workflow. */
    taskType: text("task_type").notNull(),
    /** How the execution ended, as the host's own records say. */
    execution: text({ enum: ["completed", "failed", "cancelled"] }).notNull(),
    /** Whether the task did what it was for, as far as verified. */
    result: text({ enum: ["success", "failure", "unknown"] }).notNull(),
    /** The host's execution record whose erasure erases this event. */
    evidenceId: text("evidence_id").notNull(),
    /** JSON array of references to the host's execution records. */
    evidenceRefs: text("evidence_refs").notNull(),
    /** JSON array of the versions the task ran on. */
    versionRefs: text("version_refs").notNull(),
    occurredAt: timestamp("occurred_at").notNull(),
    recordedAt: timestamp("recorded_at").notNull(),
    /**
     * The delivery that recorded it, random: its audience's members are
     * written only by that delivery, so one made again restores no member
     * a personal purge took out (../outcomes.ts).
     */
    delivery: text().notNull(),
  },
  (table) => [
    // A personal purge's delete by owner, and a person's events by time.
    index("brain_episodes_owner_idx").on(table.ownerId, table.occurredAt),
    // Erasing the events of an execution record (`eraseOutcomes`).
    index("brain_episodes_evidence_idx").on(table.evidenceId),
  ]
);

/**
 * Who a `session` event is for: its audience's members when it was
 * recorded, exactly. Goes with its event; a personal purge takes its
 * person out.
 */
export const brainEpisodeMembers = sqliteTable(
  "brain_episode_members",
  {
    episodeId: text("episode_id")
      .notNull()
      .references(() => brainEpisodes.id, { onDelete: "cascade" }),
    /** User ID. */
    userId: text("user_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.episodeId, table.userId] }),
    // A reader's events, and a personal purge's delete by person.
    index("brain_episode_members_user_idx").on(table.userId),
  ]
);

/**
 * The host's execution records whose events were erased with them (a
 * run's details past retention, a deleted chat), and single events taken
 * back on their own, keyed `episode:<event ID>`: a capture resting on one,
 * or that event delivered again, after a lost reply or still on its way,
 * is never recorded (../outcomes.ts). Their IDs alone, kept as the
 * erasure's own record.
 */
export const brainErasedEvidence = sqliteTable("brain_erased_evidence", {
  evidenceId: text("evidence_id").primaryKey(),
  erasedAt: timestamp("erased_at").notNull(),
});

/**
 * The people a personal purge forgot, and when: a capture of their work
 * from before then, delivered again after a lost reply or a restart, is
 * never recorded again, and never makes them a member again
 * (../outcomes.ts). Their user ID alone, kept for as long as a capture
 * from before could still arrive: the erasure's own record.
 */
export const brainForgottenPeople = sqliteTable("brain_forgotten_people", {
  userId: text("user_id").primaryKey(),
  forgottenAt: timestamp("forgotten_at").notNull(),
});

/**
 * How far each host boundary's deliveries reached: the highest capture
 * sequence recorded from it. Only grows, whatever order deliveries land
 * in; what the host still owes is its own backlog of capture intents.
 */
export const brainCaptureCursors = sqliteTable("brain_capture_cursors", {
  source: text().primaryKey(),
  seq: integer().notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});
