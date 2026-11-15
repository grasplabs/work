import { readableCollections } from "@grasp-os/brain/collections";
import type { CollectionRow } from "@grasp-os/brain/collections";
import { collectionIdSchema } from "@grasp-os/shared/ids";
import type { Collection } from "@grasp-os/shared/knowledge";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { collectionTeams } from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import type { Reader } from "./access.ts";
import { brainOf } from "./ports.ts";

// Knowledge's collections as the API lists them, with the teams each is
// shared with (core's database). Nothing writes a collection any more
// (GRA-1911); what a deployment holds is read until the cutover removes
// Knowledge.

/** A collection as the API returns it. */
const toCollection = (row: CollectionRow, teamIds: string[]): Collection => ({
  id: collectionIdSchema.parse(row.id),
  name: row.name,
  description: row.description,
  owner: row.owner,
  access: row.access,
  teams: teamIds,
  sensitive: row.sensitive,
  source: row.source,
  createdAt: row.createdAt.toISOString(),
});

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
        .map(({ teamId }) => teamId)
    )
  );
};
