import { and, eq, sql } from "drizzle-orm";

import { allowedFor } from "./authorize.ts";
import type { Brain } from "./brain.ts";
import { readableCollection } from "./collections.ts";
import { brainErrors } from "./contract.ts";
import { inList } from "./db/d1.ts";
import { collections, documents, versions } from "./db/schema.ts";
import { sha256Hex } from "./encoding.ts";
import type { CollectionId } from "./ids.ts";
import type { Provenance } from "./knowledge.ts";
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
  /**
   * For the exact lane (exact.ts): only sections that hold one of these,
   * each its words in a row, in place of `query`'s words.
   */
  exact?: readonly (readonly string[])[];
}

/** A document's version, as recalled evidence cites it. */
export interface VersionRef {
  documentId: string;
  collectionId: string;
  version: number;
}

/**
 * A version as it was when recalled: `text` stands for its text, a hash
 * of the payload the version was stored as. A purge points the version at
 * a new payload (purge.ts rewrites a version in place), so `text` changes
 * with it. The payload's key holds a random part, so `text` is no hash
 * anyone could check a guess of the text against, and no key derived from
 * a secret: rotating one leaves pins as they were.
 */
export interface PinnedVersion extends VersionRef {
  text: string;
}

/** What one pin is known by. */
const pinKey = ({ documentId, collectionId, version }: VersionRef): string =>
  JSON.stringify([collectionId, documentId, version]);

/**
 * The versions of `refs` that `reader` may read now, each pinned as its
 * text is now: one query, whatever their number.
 */
const readablePins = async <C>(
  brain: Brain<C>,
  reader: C,
  refs: readonly VersionRef[]
): Promise<Map<string, PinnedVersion>> => {
  if (refs.length === 0) {
    return new Map();
  }
  const allowed = await allowedFor(brain.ports, reader);
  const rows = await brain.db
    .select({
      documentId: documents.id,
      collectionId: documents.collectionId,
      version: versions.number,
      payloadKey: versions.payloadKey,
    })
    .from(versions)
    .innerJoin(documents, eq(documents.id, versions.documentId))
    .innerJoin(collections, eq(collections.id, documents.collectionId))
    .where(
      and(
        inList(documents.id, [
          ...new Set(refs.map(({ documentId }) => documentId)),
        ]),
        sql`${versions.number} IN (SELECT value FROM json_each(${JSON.stringify(
          [...new Set(refs.map(({ version }) => version))]
        )}))`,
        allowed.documents()
      )
    );
  const pins = await Promise.all(
    rows.map(async ({ payloadKey, ...ref }) => ({
      ...ref,
      text: await sha256Hex(payloadKey),
    }))
  );
  return new Map(pins.map((pin) => [pinKey(pin), pin]));
};

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
  /**
   * Each of `refs`, a document version `reader` just recalled, pinned
   * (`PinnedVersion`): refused, as `brain.not_found`, unless `reader` may
   * read them all now.
   */
  pinsOf: (reader: C, refs: readonly VersionRef[]) => Promise<PinnedVersion[]>;
  /**
   * Refuses, as `brain.not_found`, any of `pins` that `reader` may not read
   * now, or that is gone (a document deleted, or moved to another
   * collection), or whose text changed since it was pinned (a purge
   * rewrote it): one query, whatever their number.
   */
  requireDocumentsReadable: (
    reader: C,
    pins: readonly PinnedVersion[]
  ) => Promise<void>;
  /**
   * The vector lane (GRA-303), where the store has one: sections whose
   * meaning is close to `query`'s, best first, of those `reader` may read,
   * noted as read as `findEvidence` notes them. Absent until an index is
   * kept; a recall then reports the route as not enabled.
   */
  findSimilar?: (
    reader: C,
    query: EvidenceQuery
  ) => Promise<{ sections: FoundSection[]; provenance: Provenance }>;
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
  pinsOf: async (reader, refs) => {
    const readable = await readablePins(brain, reader, refs);
    return refs.map((ref) => {
      const pin = readable.get(pinKey(ref));
      if (pin === undefined) {
        throw brainErrors.create("brain.not_found");
      }
      return pin;
    });
  },
  requireDocumentsReadable: async (reader, pins) => {
    const readable = await readablePins(brain, reader, pins);
    if (pins.some((pin) => readable.get(pinKey(pin))?.text !== pin.text)) {
      throw brainErrors.create("brain.not_found");
    }
  },
  findEvidence: async (reader, { query, collectionIds, limit, exact }) =>
    await searchSections(brain, reader, query, { limit }, undefined, {
      ...(collectionIds === undefined ? {} : { among: collectionIds }),
      ...(exact === undefined ? {} : { exact }),
    }),
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
