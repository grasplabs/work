import { collectionIdSchema } from "@grasp-os/shared/ids";
import type { CollectionId } from "@grasp-os/shared/ids";
import { isAdmin } from "@grasp-os/shared/roles";
import { drizzle } from "drizzle-orm/d1";

import { appsFoundBy, appsReadableBy } from "../app-access.ts";
import type { Person } from "../app-access.ts";
import { memberOf } from "../auth/identity.ts";
import { apps } from "../db/core/schema.ts";
import { collections } from "../db/knowledge/schema.ts";
import { collectionsAllowed } from "./access.ts";
import type { Reader } from "./access.ts";
import type { Readable } from "./authorize.ts";

// Who finds what in the Apps collection (apps-collection.ts): one entry
// per App, found exactly by those who may open the App, as
// `requireAppRole` (app-access.ts) decides it: its owner and admins, and
// those it is shared with, while they may read everything it read. The
// collection is for everyone, so the rule is per document: an entry's
// path names its App, and `authorize` answers, for the collection, the
// paths of the Apps the reader may open (`Readable.only`), read from the
// core database on the same read; every query that reads documents puts
// them in its own SQL (authorize.ts). Nothing of who may open an App is
// copied into Knowledge, so unsharing, a team change, a new role or a
// source the App is granted counts from the next read.
//
// The lookup is made only when a read can reach the collection: not for
// a reader who may read no Apps collection, not for an App or agent without a
// permission to read the Apps collection (only agents are given one:
// permissions.ts `requireCollection`; an App granted it before counts it
// as a source that doesn't resolve, app-provenance.ts, so the App reaches
// nobody but its owner and admins), and not for those who may open
// every App (admins), who find every entry. Apps are never deleted, so
// every entry's App exists.

/** The Apps collection, under this ID: no other has it. */
export const appsCollectionId: CollectionId = collectionIdSchema.parse("apps");

/** Where the entry of the App `appId` is in the Apps collection. */
export const appEntryPath = (appId: string): string => `${appId}/AGENTS.md`;

/** The App whose entry is at `path`, or `undefined` if it's no entry's. */
export const appOfEntry = (path: string): string | undefined => {
  const [appId, file, ...rest] = path.split("/");
  const isEntry =
    file === "AGENTS.md" && rest.length === 0 && appId !== undefined;
  return isEntry && appId !== "" ? appId : undefined;
};

/** The person whose Apps `reader` finds; undefined once they have left. */
const personOf = async (
  env: Env,
  reader: Reader
): Promise<Person | undefined> => {
  if (reader.type === "person") {
    return reader.person;
  }
  return await memberOf(env.DB, reader.authority.onBehalfOf);
};

/** The entries a reader finds: every one, or those at these paths. */
type Found = "every" | readonly string[];

/** The entries `person` finds: those of the Apps they may open. */
const foundBy = async (env: Env, person: Person): Promise<Found> => {
  // Who may open every App (as `appFor` decides it), whatever it read.
  if (isAdmin(person.role)) {
    return "every";
  }
  const rows = await drizzle(env.DB)
    .select({ id: apps.id })
    .from(apps)
    .where(appsFoundBy(env, person));
  const ids = rows.map(({ id }) => id);
  const open = await appsReadableBy(env, person, ids);
  return ids.filter((id) => open.has(id)).map(appEntryPath);
};

/**
 * What `reader` may read now: the collections `collectionsAllowed` lets
 * them (access.ts), and of the Apps collection only the entries of Apps
 * they may open. Knowledge's `authorize` port (ports.ts).
 */
export const authorize = async (
  env: Env,
  reader: Reader
): Promise<Readable> => {
  const db = drizzle(env.KNOWLEDGE);
  const { condition, shared } = await collectionsAllowed(env, db, reader);
  const rows = await db
    .select({ id: collections.id })
    .from(collections)
    .where(condition);
  const ids = rows.map(({ id }) => id);
  // Who may open an App is decided person by person: in a chat others
  // share, the asker's Apps would reach people who can't open them.
  if (shared) {
    return { collections: ids, only: { [appsCollectionId]: [] } };
  }
  const person = ids.includes(appsCollectionId)
    ? await personOf(env, reader)
    : undefined;
  const found: Found = person ? await foundBy(env, person) : [];
  return found === "every"
    ? { collections: ids }
    : { collections: ids, only: { [appsCollectionId]: found } };
};
