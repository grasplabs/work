import { readableCollections } from "@grasp-os/brain/collections";
import type { CollectionRow } from "@grasp-os/brain/collections";
import { collectionIdSchema } from "@grasp-os/shared/ids";
import { knowledgeErrors, readOnlySources } from "@grasp-os/shared/knowledge";
import type { Collection } from "@grasp-os/shared/knowledge";
import type { Identity } from "@grasp-os/shared/rpc";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { collectionTeams } from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { canWrite } from "./access.ts";
import type { Reader } from "./access.ts";
import { brainOf } from "./ports.ts";

// Core's rules for Knowledge's collections: who may create and change
// which, the teams a collection is shared with (core's database), and the
// collection as the API returns it. Knowledge stores collections; who may
// do what with them is core's.

/**
 * A collection as the API returns it: `writable` for the person who asked,
 * which covers uploading too, as an upload is a change like any other
 * (uploads.ts).
 */
const toCollection = (
  row: CollectionRow,
  teamIds: string[],
  writable: boolean
): Collection => ({
  id: collectionIdSchema.parse(row.id),
  name: row.name,
  description: row.description,
  owner: row.owner,
  access: row.access,
  teams: teamIds,
  sensitive: row.sensitive,
  source: row.source,
  createdAt: row.createdAt.toISOString(),
  writable,
});

/**
 * Refuses a change to `collection` that `person` may not make: one to a
 * collection only the platform writes, or one their access doesn't allow.
 */
export const requireWritable = (
  env: Env,
  person: Pick<Identity, "userId" | "role">,
  collection: CollectionRow
): void => {
  if (readOnlySources.has(collection.source)) {
    throw knowledgeErrors.create("knowledge.read_only");
  }
  if (!canWrite(person, collection)) {
    throw knowledgeErrors.create("knowledge.forbidden");
  }
};

/**
 * Whether `requireWritable` lets `person` change `collection`: the same
 * rule, for showing only the changes core would take.
 */
export const isWritable = (
  env: Env,
  person: Pick<Identity, "userId" | "role">,
  collection: CollectionRow
): boolean => {
  try {
    requireWritable(env, person, collection);
    return true;
  } catch {
    return false;
  }
};

/** The collections `reader` may read, by name. */
export const listCollections = async (
  env: Env,
  reader: Reader
): Promise<Collection[]> => {
  const rows = await readableCollections(brainOf(env), reader);
  const shared =
    rows.length === 0
      ? []
      : await drizzle(env.DB)
          .select({
            collectionId: collectionTeams.collectionId,
            teamId: collectionTeams.teamId,
          })
          .from(collectionTeams)
          .where(
            inList(
              collectionTeams.collectionId,
              rows.map(({ id }) => id)
            )
          )
          .orderBy(asc(collectionTeams.teamId));
  return rows.map((row) =>
    toCollection(
      row,
      shared
        .filter(({ collectionId }) => collectionId === row.id)
        .map(({ teamId }) => teamId),
      reader.type === "person" && isWritable(env, reader.person, row)
    )
  );
};
