import { brainErrors } from "@grasp-os/shared/brain-api";
import type { CollectionId } from "@grasp-os/shared/ids";
import type { Provenance } from "@grasp-os/shared/knowledge";
import type { Authority } from "@grasp-os/shared/permissions";
import { drizzle } from "drizzle-orm/d1";

import { collections } from "../db/knowledge/schema.ts";
import { grantedPermissions } from "../permissions.ts";
import type { Reader } from "./access.ts";
import { allowedFor } from "./authorize.ts";
import { readableCollection } from "./collections.ts";
import { portsOf } from "./ports.ts";
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
export interface BrainStore {
  /**
   * Refuses, as `brain.denied`, an App, run or agent without an active
   * `brain` grant, read now: a person needs none. The grant lets it recall;
   * what it recalls from is still only the collections it was granted.
   */
  requireBrainGrant: (reader: Reader) => Promise<void>;
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

/**
 * Whether `authority` holds an active `brain` grant, read now: what an
 * App, run or agent needs to recall. A chat asks it before recalling for
 * a question (agent.ts), and recall asks it again as it reads.
 */
export const hasBrainGrant = async (
  env: Env,
  authority: Authority
): Promise<boolean> => {
  const granted = await grantedPermissions(env, authority);
  return granted.some(
    ({ object, actions }) =>
      object.type === "platform" && actions.includes("brain")
  );
};

/** The Brain's store over Knowledge's D1 database. */
export const d1BrainStore = (env: Env): BrainStore => ({
  requireBrainGrant: async (reader) => {
    if (reader.type === "person") {
      return;
    }
    if (!(await hasBrainGrant(env, reader.authority))) {
      throw brainErrors.create("brain.denied");
    }
  },
  requireReadable: async (reader, collectionIds) => {
    const db = drizzle(env.KNOWLEDGE);
    const allowed = await allowedFor(portsOf(env), reader);
    await Promise.all(
      collectionIds.map(
        async (collectionId) =>
          await readableCollection(db, allowed.collections, collectionId)
      )
    );
  },
  findEvidence: async (reader, { query, collectionIds, limit }) =>
    await searchSections(
      env,
      reader,
      query,
      { limit },
      undefined,
      collectionIds === undefined ? {} : { among: collectionIds }
    ),
  accessKey: async (reader) => {
    // What may be read now: each collection the reader may read, with
    // what decides who reads it (its access, whether it is sensitive),
    // and for an App or agent its grants, the brain grant among them. A
    // change to any of those changes the key.
    const db = drizzle(env.KNOWLEDGE);
    const allowed = await allowedFor(portsOf(env), reader);
    const readable = await db
      .select({
        id: collections.id,
        access: collections.access,
        sensitive: collections.sensitive,
      })
      .from(collections)
      .where(allowed.collections)
      .orderBy(collections.id);
    const permissions =
      reader.type === "person"
        ? []
        : await grantedPermissions(env, reader.authority);
    const grants = permissions.map(({ id }) => id).toSorted();
    return JSON.stringify([
      reader.type,
      reader.type === "person"
        ? reader.person.userId
        : reader.authority.onBehalfOf,
      reader.type === "person" ? null : (reader.permissionId ?? null),
      grants,
      readable.map(({ id, access, sensitive }) => [id, access, sensitive]),
    ]);
  },
});
