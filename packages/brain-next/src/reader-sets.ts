import { eq } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

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
