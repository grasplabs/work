import { and, eq, max } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { chunksOf } from "./chunks.ts";
import type {
  CurrentRequest,
  NewSource,
  SourceVersion,
  SourceVersionRef,
  VersionRequest,
} from "./contract.ts";
import {
  chunks,
  currentVersions,
  readerSets,
  sourceChanges,
  sourceVersions,
} from "./db/schema.ts";
import {
  fileKeyOf,
  hashOf,
  holdFile,
  isHeld,
  isInDoubt,
  noteWrite,
} from "./files.ts";
import { readableSql, readerSetKeyOf, readerSetOf } from "./reader-sets.ts";
import { removeVectorsOf } from "./vectors.ts";
import { indexWords } from "./words.ts";

// Sources and their versions. A source is an identity its host gives;
// each change its producer adds is a version of it, never written over
// the last: the newest is current, and recall searches it alone, while
// the ones before stay as history. Each version's text is kept whole as a
// file in R2 (files.ts) and in chunks in the store (chunks.ts), whose
// words recall searches. An instruction file is a source kept whole
// only: it has no chunks, so recall never finds it, and it is read whole
// by its current version (`readCurrent`).
//
// An add is recognised as one already made, in this order:
//
// 1. By its change key: the same key answers with the version it made,
//    whatever was added since, so a late retry never brings back what a
//    later version replaced. The same key with other text or readers is
//    refused.
// 2. A new key with the same text and readers as the current version is
//    that version (nothing changed), and the key is kept for it.
//
// Both are asked again in the transaction that writes a version, so
// adds racing each other make one version.

/** The store's own parts an add or a read needs. */
export interface SourcesStore {
  readonly storage: DurableObjectStorage;
  readonly db: DrizzleSqliteDODatabase;
  readonly bucket: R2Bucket;
}

const encoder = new TextEncoder();

/**
 * An add, with what it is compared by (its file's hash and its readers'
 * key), and whether its text is indexed for recall: an instruction file's
 * never is (contract.ts `addInstructions`).
 */
interface Adding {
  readonly added: NewSource;
  readonly hash: string;
  readonly readers: string;
  readonly indexed: boolean;
}

/** A version, as an add finds it: its row, number, file and readers' key. */
const versionFields = {
  row: sourceVersions.row,
  version: sourceVersions.version,
  file: sourceVersions.file,
  readers: readerSets.key,
};

/**
 * The version `adding` already made or matches, by the order above,
 * keeping a new change's key for the current version it matches; or
 * `undefined` when it is a new version. Throws when its change was added
 * before with other text or readers.
 */
const madeBefore = (
  db: DrizzleSqliteDODatabase,
  { added, hash, readers }: Adding
): SourceVersionRef | undefined => {
  const byChange = db
    .select(versionFields)
    .from(sourceChanges)
    .innerJoin(sourceVersions, eq(sourceVersions.row, sourceChanges.versionRow))
    .innerJoin(readerSets, eq(readerSets.id, sourceVersions.readerSet))
    .where(
      and(
        eq(sourceChanges.source, added.source),
        eq(sourceChanges.change, added.change)
      )
    )
    .get();
  if (byChange !== undefined) {
    if (byChange.file !== hash || byChange.readers !== readers) {
      throw new Error(
        "The Brain refused it: this change was added before with other text or readers"
      );
    }
    return { source: added.source, version: byChange.version };
  }
  const current = db
    .select(versionFields)
    .from(currentVersions)
    .innerJoin(
      sourceVersions,
      eq(sourceVersions.row, currentVersions.versionRow)
    )
    .innerJoin(readerSets, eq(readerSets.id, sourceVersions.readerSet))
    .where(eq(currentVersions.source, added.source))
    .get();
  if (
    current === undefined ||
    current.file !== hash ||
    current.readers !== readers
  ) {
    return undefined;
  }
  db.insert(sourceChanges)
    .values({
      source: added.source,
      change: added.change,
      versionRow: current.row,
    })
    .run();
  return { source: added.source, version: current.version };
};

/**
 * Writes the next version of `adding.added.source`, whole: the version,
 * its chunks and their words when it is indexed, its count on the file,
 * its change, and the source's current pointer, which makes it visible and
 * removes the vector codes of the version it replaces (vectors.ts). Run it
 * in one transaction. Answers `undefined` when the file's row is gone (swept
 * since it was noted), noting it again for the sweep to find what the add
 * wrote; and, writing nothing, when a delete of the file may still land
 * (a sweep gave up waiting for R2 while this add's write was under way).
 */
const record = (
  db: DrizzleSqliteDODatabase,
  storage: DurableObjectStorage,
  adding: Adding
): SourceVersionRef | undefined => {
  // The same change, or the same text and readers, added meanwhile.
  const before = madeBefore(db, adding);
  if (before !== undefined) {
    return before;
  }
  const { added, hash } = adding;
  if (isInDoubt(db, hash)) {
    return undefined;
  }
  if (!holdFile(db, hash)) {
    noteWrite(db, hash);
    return undefined;
  }
  const last = db
    .select({ version: max(sourceVersions.version) })
    .from(sourceVersions)
    .where(eq(sourceVersions.source, added.source))
    .get();
  const version = (last?.version ?? 0) + 1;
  const { row } = db
    .insert(sourceVersions)
    .values({
      source: added.source,
      version,
      file: hash,
      readerSet: readerSetOf(db, added.access),
      addedAt: new Date(),
    })
    .returning({ row: sourceVersions.row })
    .get();
  const indexed = adding.indexed ? chunksOf(added.text) : [];
  for (const [position, chunk] of indexed.entries()) {
    const written = db
      .insert(chunks)
      .values({ versionRow: row, position, text: chunk })
      .returning({ row: chunks.row })
      .get();
    indexWords(storage.sql, written.row, chunk);
  }
  db.insert(sourceChanges)
    .values({ source: added.source, change: added.change, versionRow: row })
    .run();
  // The version before stops being found by meaning as it stops being
  // current: its chunks' vector codes go with the pointer.
  const replaced = db
    .select({ versionRow: currentVersions.versionRow })
    .from(currentVersions)
    .where(eq(currentVersions.source, added.source))
    .get();
  if (replaced !== undefined) {
    removeVectorsOf(storage.sql, replaced.versionRow);
  }
  db.insert(currentVersions)
    .values({ source: added.source, versionRow: row })
    .onConflictDoUpdate({
      target: currentVersions.source,
      set: { versionRow: row },
    })
    .run();
  return { source: added.source, version };
};

/** What an add that must be made again says: the same words as a lost file's. */
const addAgain = "The Brain lost the file while adding it: add it again";

/**
 * Adds `added` as a version of its source, or answers with the version it
 * already is (above): the file first, then the version whole. So an add
 * can be repeated after a lost reply, or after a crash between the file
 * and the version, which it then finishes. Its text is cut into chunks
 * and indexed for recall when `indexed`; otherwise it is only kept whole.
 */
export const addVersion = async (
  { storage, db, bucket }: SourcesStore,
  added: NewSource,
  { indexed }: { indexed: boolean }
): Promise<SourceVersionRef> => {
  const body = encoder.encode(added.text);
  const adding: Adding = {
    added,
    hash: await hashOf(body),
    readers: readerSetKeyOf(added.access),
    indexed,
  };
  const before = madeBefore(db, adding);
  if (before !== undefined) {
    return before;
  }
  // A delete of this file may still land (a sweep gave up waiting for R2):
  // writing it now could lose it under a version. Added again later.
  if (isInDoubt(db, adding.hash)) {
    throw new Error(addAgain);
  }
  if (!isHeld(db, adding.hash)) {
    noteWrite(db, adding.hash);
    // R2 checks the bytes against the hash as it takes them.
    await bucket.put(fileKeyOf(adding.hash), body, {
      sha256: adding.hash,
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
  }
  const recorded = storage.transactionSync(() => record(db, storage, adding));
  if (recorded === undefined) {
    throw new Error(addAgain);
  }
  return recorded;
};

/** The text of a version's file, under its hash `file`. */
const textOf = async (bucket: R2Bucket, file: string): Promise<string> => {
  const object = await bucket.get(fileKeyOf(file));
  if (object === null) {
    throw new Error("The Brain's file of a version is missing");
  }
  return await object.text();
};

/**
 * `?1` the source, `?2` the reader's person, `?3` their groups (JSON), `?4`
 * the version: its file and when it was added, if the reader is among
 * that version's readers and the source's current version's. So
 * narrowing a source's readers hides its history from those taken off,
 * and a person or group added as a reader in a later version never sees
 * the versions before. Both are matched against the groups the host
 * counts the reader in now (the Brain keeps no membership): someone who
 * joins a group reads what that group could read from before they
 * joined.
 */
const versionSql = `
WITH ${readableSql}
SELECT file, added_at FROM source_versions
WHERE source = ?1 AND version = ?4
  AND reader_set IN (SELECT reader_set FROM readable)
  AND EXISTS (
    SELECT 1 FROM current_versions
    JOIN source_versions AS current ON current.row = current_versions.version_row
    WHERE current_versions.source = ?1
      AND current.reader_set IN (SELECT reader_set FROM readable)
  )`;

/**
 * A version of a source, current or history, whole from its file:
 * `null` when there is none or `reader` may not read it (above), alike.
 */
export const readVersion = async (
  { storage, bucket }: SourcesStore,
  { source, version, reader }: VersionRequest
): Promise<SourceVersion | null> => {
  const found = storage.sql
    .exec<{ file: string; added_at: number }>(
      versionSql,
      source,
      reader.person,
      JSON.stringify(reader.groups),
      version
    )
    .toArray()
    .at(0);
  if (found === undefined) {
    return null;
  }
  return {
    source,
    version,
    text: await textOf(bucket, found.file),
    addedAt: new Date(found.added_at),
  };
};

/**
 * `?1` the sources (JSON), `?2` the reader's person, `?3` their groups
 * (JSON): each source's current version the reader may read, its number,
 * file and when it was added, in the order the sources are given.
 */
const currentSql = `
WITH ${readableSql}
SELECT asked.value AS source, source_versions.version AS version,
  source_versions.file AS file, source_versions.added_at AS added_at
FROM json_each(?1) AS asked
JOIN current_versions ON current_versions.source = asked.value
JOIN source_versions ON source_versions.row = current_versions.version_row
WHERE source_versions.reader_set IN (SELECT reader_set FROM readable)
ORDER BY asked.key`;

/**
 * The current version of each of `sources`, whole from its file, in the
 * order given: leaving out each that doesn't exist and each `reader` may
 * not read, alike.
 */
export const readCurrent = async (
  { storage, bucket }: SourcesStore,
  { sources, reader }: CurrentRequest
): Promise<SourceVersion[]> => {
  const found = storage.sql
    .exec<{ source: string; version: number; file: string; added_at: number }>(
      currentSql,
      JSON.stringify(sources),
      reader.person,
      JSON.stringify(reader.groups)
    )
    .toArray();
  return await Promise.all(
    found.map(async ({ source, version, file, added_at: addedAt }) => ({
      source,
      version,
      text: await textOf(bucket, file),
      addedAt: new Date(addedAt),
    }))
  );
};
