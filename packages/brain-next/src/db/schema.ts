import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
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
 * A source, whole, with its set of readers. Its words are indexed in
 * `source_words`, an FTS5 table kept in step by triggers (migration 0001).
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
