import { actorOf } from "@grasp-os/shared/audit";
import { collectionIdSchema } from "@grasp-os/shared/ids";
import {
  collectionInputSchema,
  knowledgeErrors,
  readOnlySources,
} from "@grasp-os/shared/knowledge";
import type { Collection, CollectionSource } from "@grasp-os/shared/knowledge";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { organizationId } from "../auth/auth.ts";
import { collectionTeams, teams } from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { canCreate, canWrite } from "./access.ts";
import type { Reader } from "./access.ts";
import { ensureCollection, readableCollections } from "./collections.ts";
import type { CollectionRow } from "./collections.ts";
import { portsOf } from "./ports.ts";

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
  const rows = await readableCollections(env, reader);
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

/** The IDs in `teamIds` that aren't teams of the organization. */
const unknownTeams = async (env: Env, teamIds: string[]): Promise<string[]> => {
  if (teamIds.length === 0) {
    return [];
  }
  const found = await drizzle(env.DB)
    .select({ id: teams.id })
    .from(teams)
    .where(
      and(eq(teams.organizationId, organizationId), inList(teams.id, teamIds))
    );
  const known = new Set(found.map(({ id }) => id));
  return teamIds.filter((id) => !known.has(id));
};

/**
 * Creates a collection `person` owns. People create collections written
 * here; the platform passes the `source` of the collections it fills
 * (uploads, Grasp's own, Apps').
 */
export const createCollection = async (
  env: Env,
  person: Identity,
  input: unknown,
  source: CollectionSource = "here"
): Promise<Collection> => {
  const {
    name,
    description,
    access,
    teams: teamIds,
    sensitive,
  } = knowledgeErrors.parse("knowledge.invalid", collectionInputSchema, input);
  if (!canCreate(person, access)) {
    throw knowledgeErrors.create("knowledge.forbidden");
  }
  const unknown = await unknownTeams(env, teamIds);
  if (unknown.length > 0) {
    throw knowledgeErrors.create("knowledge.invalid", {
      issues: unknown.map((id) => `teams: there's no team ${id}`),
    });
  }
  const id = crypto.randomUUID();
  const row: CollectionRow = {
    id,
    name,
    description,
    owner: person.userId,
    access,
    sensitive,
    source,
    createdAt: portsOf(env).clock(),
  };
  // The teams first, in core's database: should the collection then fail,
  // they name a collection nobody has, which nothing reads.
  if (teamIds.length > 0) {
    await drizzle(env.DB)
      .insert(collectionTeams)
      .values(teamIds.map((teamId) => ({ collectionId: row.id, teamId })));
  }
  // A new ID: created now, with its audit event.
  await ensureCollection(env, row, actorOf(person));
  return toCollection(row, teamIds, isWritable(env, person, row));
};
