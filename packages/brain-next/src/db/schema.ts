import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
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
 * answers with that version, whatever was added since (sources.ts).
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
