import type { CollectionId } from "@grasp-os/shared/ids";
import type { Provenance } from "@grasp-os/shared/knowledge";

import { collections } from "../db/knowledge/schema.ts";
import { allowedFor } from "./authorize.ts";
import type { Brain } from "./brain.ts";
import { readableCollection } from "./collections.ts";
import { searchSections } from "./search.ts";
import type { FoundSection } from "./search.ts";

// What recall (recall.ts) reads, and nothing more: the Brain's narrow
// store (the Brain design's "Keep SQL inside the storage boundary"). Each
// method states a read's intent; none takes SQL or a table. The D1 store
// reads through Knowledge's one access predicate (access.ts), so recall
// never decides what may be read itself.

/** A read of evidence for words, in some collections or all a reader may. */
export interface EvidenceQuery {
  query: string;
  /**
   * Only these, each refused as not found unless the reader may read it;
   * every one the reader may read if absent.
   */
  collectionIds?: readonly CollectionId[];
  /** Most sections to return, best first. */
  limit: number;
}

/** The Brain's store, as recall reads it. */
export interface BrainStore<C> {
  /**
   * Refuses, as `brain.denied`, an App, run or agent without an active
   * `brain` grant, read now: a person needs none. The grant lets it recall;
   * what it recalls from is still only the collections it was granted.
   */
  requireBrainGrant: (reader: C) => Promise<void>;
  /**
   * Refuses, as `knowledge.not_found`, unless `reader` may read every one
   * of `collectionIds`: the same answer whether one is missing or hidden.
   * Reads nothing of what they hold.
   */
  requireReadable: (
    reader: C,
    collectionIds: readonly CollectionId[]
  ) => Promise<void>;
  /** Sections that match `query`, best first, of those `reader` may read. */
  findEvidence: (
    reader: C,
    query: EvidenceQuery
  ) => Promise<{ sections: FoundSection[]; provenance: Provenance }>;
  /**
   * What `reader` may read now, as a value that changes when that does:
   * the collections it was granted, for an App or agent, or who the
   * person is and which teams they are in.
   */
  accessKey: (reader: C) => Promise<string>;
}

/** The Brain's store over Knowledge's D1 database. */
export const d1BrainStore = <C>(brain: Brain<C>): BrainStore<C> => ({
  requireBrainGrant: async (reader) => {
    await brain.ports.recall.require(reader);
  },
  requireReadable: async (reader, collectionIds) => {
    const { db } = brain;
    const allowed = await allowedFor(brain.ports, reader);
    await Promise.all(
      collectionIds.map(
        async (collectionId) =>
          await readableCollection(db, allowed.collections, collectionId)
      )
    );
  },
  findEvidence: async (reader, { query, collectionIds, limit }) =>
    await searchSections(
      brain,
      reader,
      query,
      { limit },
      undefined,
      collectionIds === undefined ? {} : { among: collectionIds }
    ),
  accessKey: async (reader) => {
    // What may be read now: each collection the reader may read, with
    // what decides who reads it (its access, whether it is sensitive),
    // and who the reader is as the host says (`recall.key`: core's names
    // an App's or agent's grants, the brain grant among them). A change to
    // any of those changes the key.
    const { db } = brain;
    const allowed = await allowedFor(brain.ports, reader);
    const readable = await db
      .select({
        id: collections.id,
        access: collections.access,
        sensitive: collections.sensitive,
      })
      .from(collections)
      .where(allowed.collections)
      .orderBy(collections.id);
    return JSON.stringify([
      await brain.ports.recall.key(reader),
      readable.map(({ id, access, sensitive }) => [id, access, sensitive]),
    ]);
  },
});
