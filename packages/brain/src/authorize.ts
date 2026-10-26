import { and, eq, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { inList, notInList } from "./db/d1.ts";
import { brainDocumentCites, collections, documents } from "./db/schema.ts";
import type { DetailValue } from "./events.ts";

// What a reader may read, as the host decides it: Knowledge holds no
// roles, teams, people or Apps. The host's `authorize` port (ports.ts)
// answers with the collections a reader may read now and, for a
// collection whose documents have audiences of their own, the paths in it
// they may read. Every query that reads collections, documents, versions,
// sections or links puts `allowedOf`'s conditions inside its own SQL,
// never as a filter afterwards, so no path (listing, history, backlinks,
// search, recall) shows more than a read would.

/** What a reader may read now, as the host's `authorize` port says. */
export interface Readable {
  /** The collections they may read. */
  collections: readonly string[];
  /**
   * Of these collections, only these paths: for one whose documents each
   * have their own audience (core's Apps collection: an App's entry, for
   * those who may open the App). A collection not named here is read
   * whole.
   */
  only?: Readonly<Record<string, readonly string[]>>;
}

/** What a reader may read, as conditions on `collections`. */
export interface Allowed {
  /** The collections they may read. */
  collections: SQL;
  /**
   * The documents they may read, as a condition on `collections` and on
   * the document's row (`documents` unless an alias of it): those of
   * `collections`, in a collection `Readable.only` names only those at its
   * paths, and whose current and indexed versions rest on nothing they
   * may not read (`version`).
   */
  documents: (of?: DocumentColumns) => SQL;
  /**
   * That version `version` of document `id` rests on nothing they may not
   * read (`brain_document_cites`, GRA-1093): every collection it cites is
   * one they may read, and every document it cites is still in its
   * collection. A version written by a person's own save cites nothing.
   */
  version: (id: SQLiteColumn | SQL, version: SQLiteColumn | SQL) => SQL;
}

/** The columns of a document row (`documents`, or an alias of it). */
export interface DocumentColumns {
  id: SQLiteColumn;
  path: SQLiteColumn;
  currentVersion: SQLiteColumn;
  indexedVersion: SQLiteColumn;
}

/** `readable` as conditions every read puts inside its SQL. */
export const allowedOf = ({
  collections: ids,
  only = {},
}: Readable): Allowed => {
  // Unary plus: the list filters the rows a read reaches through its own
  // indexes (full-text, a document's state), never drives the read, which
  // would then walk every document of every collection in it.
  const inCollections =
    ids.length === 0 ? sql`0` : inList(sql`+${collections.id}`, ids);
  const limited = Object.entries(only).filter(([id]) => ids.includes(id));
  const readable = JSON.stringify(ids);
  const version = (id: SQLiteColumn | SQL, at: SQLiteColumn | SQL): SQL =>
    sql`NOT EXISTS (SELECT 1 FROM ${brainDocumentCites} AS cite WHERE cite.document_id = ${id} AND cite.version = ${at} AND (cite.collection_id NOT IN (SELECT value FROM json_each(${readable})) OR (cite.cited_document_id <> '' AND NOT EXISTS (SELECT 1 FROM ${documents} AS cited WHERE cited.id = cite.cited_document_id AND cited.collection_id = cite.collection_id))))`;
  return {
    collections: inCollections,
    version,
    documents: (of = documents) => {
      // Its current version, and the one search holds the sections of,
      // which may still be an older one (indexing.ts).
      const rests = and(
        version(of.id, of.currentVersion),
        version(of.id, of.indexedVersion)
      );
      const { path } = of;
      if (limited.length === 0) {
        return and(inCollections, rests) ?? sql`0`;
      }
      const whole = notInList(
        collections.id,
        limited.map(([id]) => id)
      );
      const atPaths = limited.map(([id, paths]) =>
        paths.length === 0
          ? sql`0`
          : and(eq(collections.id, id), inList(path, paths))
      );
      return and(inCollections, or(whole, ...atPaths), rests) ?? sql`0`;
    },
  };
};

/** What `reader` may read now, as `authorize` (the host's port) says. */
export const allowedFor = async <Caller>(
  { authorize }: { authorize: (caller: Caller) => Promise<Readable> },
  reader: Caller
): Promise<Allowed> => allowedOf(await authorize(reader));

/**
 * A read, as Knowledge reports it to the host's `onRead` port (ports.ts),
 * which records it: which read (`knowledge.read`, with `detail.read`
 * naming it, or a search), what it was of, and the documents it returned
 * beyond that (a search's hits). Identifiers and counts only, never what
 * was read or searched for.
 */
export interface ReadRecord {
  action:
    | "knowledge.read"
    | "knowledge.search"
    | "knowledge.search.empty"
    | "knowledge.skill.select";
  target?: { type: "document" | "collection"; id: string };
  documentIds?: string[];
  detail: Record<string, DetailValue>;
}
