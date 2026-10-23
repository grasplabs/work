import { and, eq, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { inList, notInList } from "../db/d1.ts";
import { collections, documents } from "../db/knowledge/schema.ts";

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
   * the column that has their path (`documents.path` unless an alias's):
   * those of `collections`, and in a collection `Readable.only` names,
   * only those at its paths.
   */
  documents: (path?: SQLiteColumn) => SQL;
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
  return {
    collections: inCollections,
    documents: (path = documents.path) => {
      if (limited.length === 0) {
        return inCollections;
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
      return and(inCollections, or(whole, ...atPaths)) ?? sql`0`;
    },
  };
};

/** What `reader` may read now, as `authorize` (the host's port) says. */
export const allowedFor = async <Caller>(
  { authorize }: { authorize: (caller: Caller) => Promise<Readable> },
  reader: Caller
): Promise<Allowed> => allowedOf(await authorize(reader));
