import { eq } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import type { Access } from "./contract.ts";
import { readerSetMembers, readerSets } from "./db/schema.ts";

/** One principal of a set of readers: a person or a group. */
interface Principal {
  kind: "person" | "group";
  principal: string;
}

/** The principals `access` names: none when nobody is known to read it. */
const principalsOf = (access: Access): Principal[] => {
  switch (access.kind) {
    case "owner": {
      return [{ kind: "person", principal: access.person }];
    }
    case "audience": {
      return [{ kind: "group", principal: access.group }];
    }
    case "none": {
      return [];
    }
    default: {
      throw new Error("Unknown access");
    }
  }
};

/** Code unit order: the same in every locale, so a key never depends on one. */
const byCodeUnits = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

/**
 * A set's key: each principal as JSON, `[kind, id]`, sorted, in a JSON
 * array. The same principals in any order give the same key.
 */
const keyOf = (principals: readonly Principal[]): string =>
  `[${principals
    .map(({ kind, principal }) => JSON.stringify([kind, principal]))
    .toSorted(byCodeUnits)
    .join(",")}]`;

/** The key of the set of readers `access` names. */
export const readerSetKeyOf = (access: Access): string =>
  keyOf(principalsOf(access));

/**
 * The sets of readers a reader is in, as a common table `readable` for a
 * statement whose `?2` is the reader's person and `?3` their groups
 * (JSON). Principals are matched with their kind, so a person never
 * matches a group of the same name, and a set with no principals matches
 * no one. Each set once.
 *
 * One lookup of the members' index per principal, whatever SQLite's
 * statistics say: the groups come first (`CROSS JOIN` keeps SQLite to
 * that order), and a `UNION` rather than an `OR`, which SQLite's planner
 * may answer, once it has statistics, by reading every member.
 */
export const readableSql = `readable AS (
  SELECT reader_set FROM reader_set_members
  WHERE kind = 'person' AND principal = ?2
  UNION
  SELECT reader_set_members.reader_set FROM json_each(?3) AS asked
  CROSS JOIN reader_set_members
    ON reader_set_members.kind = 'group'
    AND reader_set_members.principal = asked.value
)`;

/**
 * The set of readers `access` names, made the first time it is needed and
 * shared by every item with the same readers after that. Call it in the
 * transaction that writes the item, so a set and its members are whole
 * before anything points at it.
 */
export const readerSetOf = (
  db: DrizzleSqliteDODatabase,
  access: Access
): number => {
  const principals = principalsOf(access);
  const key = keyOf(principals);
  const known = db
    .select({ id: readerSets.id })
    .from(readerSets)
    .where(eq(readerSets.key, key))
    .get();
  if (known !== undefined) {
    return known.id;
  }
  const { id } = db
    .insert(readerSets)
    .values({ key })
    .returning({ id: readerSets.id })
    .get();
  if (principals.length > 0) {
    db.insert(readerSetMembers)
      .values(principals.map((principal) => ({ readerSet: id, ...principal })))
      .run();
  }
  return id;
};

/** A set's key, as `keyOf` writes it: its principals, `[kind, id]` each. */
const keySchema = z.array(z.tuple([z.enum(["person", "group"]), z.string()]));

/**
 * Makes again each set of readers that memories or extraction marks name
 * by key and the store no longer holds: what an older release dropped
 * when it saw nothing else use it (an admin's rollback). A key is the
 * set's principals, so the set it makes is the one that was. One scan of
 * the index of keys each names (`memories_readers_idx`,
 * `memory_extractions_readers_idx`). Run in the caller's transaction.
 */
export const rebuildMissingSets = (sql: SqlStorage): void => {
  const missing = sql
    .exec<{ readers: string }>(
      `SELECT readers FROM (
        SELECT DISTINCT readers FROM memories
        UNION SELECT DISTINCT readers FROM memory_extractions
      ) WHERE readers NOT IN (SELECT key FROM reader_sets)`
    )
    .toArray();
  for (const { readers } of missing) {
    const principals = keySchema.parse(JSON.parse(readers));
    const { id } = sql
      .exec<{ id: number }>(
        "INSERT INTO reader_sets (key) VALUES (?) RETURNING id",
        readers
      )
      .one();
    for (const [kind, principal] of principals) {
      sql.exec(
        "INSERT INTO reader_set_members (reader_set, kind, principal) VALUES (?, ?, ?)",
        id,
        kind,
        principal
      );
    }
  }
};
