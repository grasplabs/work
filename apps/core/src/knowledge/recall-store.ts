import type { CollectionId } from "@grasp-os/shared/ids";
import type { Provenance } from "@grasp-os/shared/knowledge";
import { drizzle } from "drizzle-orm/d1";

import type { Reader } from "./access.ts";
import { collectionsAllowed } from "./access.ts";
import { readableCollection } from "./collections.ts";
import { searchSections } from "./search.ts";
import type { FoundSection } from "./search.ts";

// What recall (recall.ts) reads, and nothing more: the Brain's narrow
// store (the Brain design's "Keep SQL inside the storage boundary"). Each
// method states a read's intent; none takes SQL or a table. The D1 store
// reads through Knowledge's one access predicate (access.ts), so recall
// never decides what may be read itself.

/** A read of evidence for words, in one collection or all a reader may. */
export interface EvidenceQuery {
  query: string;
  /** Only this collection; every one the reader may read if absent. */
  collectionId?: CollectionId;
  /** Most sections to return, best first. */
  limit: number;
}

/** The Brain's store, as recall reads it. */
export interface BrainStore {
  /**
   * Refuses, as `knowledge.not_found`, unless `reader` may read every one
   * of `collectionIds`: the same answer whether one is missing or hidden.
   * Reads nothing of what they hold.
   */
  requireReadable: (
    reader: Reader,
    collectionIds: readonly CollectionId[]
  ) => Promise<void>;
  /** Sections that match `query`, best first, of those `reader` may read. */
  findEvidence: (
    reader: Reader,
    query: EvidenceQuery
  ) => Promise<{ sections: FoundSection[]; provenance: Provenance }>;
  /**
   * What `reader` may read now, as a value that changes when that does:
   * the collections it was granted, for an App or agent, or who the
   * person is and which teams they are in.
   */
  accessKey: (reader: Reader) => Promise<string>;
}

/** The Brain's store over Knowledge's D1 database. */
export const d1BrainStore = (env: Env): BrainStore => ({
  requireReadable: async (reader, collectionIds) => {
    const db = drizzle(env.KNOWLEDGE);
    const { condition } = await collectionsAllowed(env, db, reader);
    await Promise.all(
      collectionIds.map(
        async (collectionId) =>
          await readableCollection(db, condition, collectionId)
      )
    );
  },
  findEvidence: async (reader, { query, collectionId, limit }) =>
    collectionId === undefined
      ? await searchSections(env, reader, query, { limit })
      : await searchSections(env, reader, query, { limit }, collectionId),
  accessKey: async (reader) => {
    if (reader.type === "person") {
      const { userId, role, teams } = reader.person;
      return JSON.stringify([
        "person",
        userId,
        role,
        teams.map(({ id }) => id).toSorted(),
      ]);
    }
    const db = drizzle(env.KNOWLEDGE);
    const { granted } = await collectionsAllowed(env, db, reader);
    return JSON.stringify([
      "delegate",
      reader.authority.onBehalfOf,
      reader.permissionId ?? null,
      [...(granted ?? [])].toSorted(),
    ]);
  },
});
