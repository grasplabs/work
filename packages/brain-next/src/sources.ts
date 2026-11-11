import { and, eq, max } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { chunksOf } from "./chunks.ts";
import type {
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
import { fileKeyOf, hashOf, holdFile, isHeld, noteWrite } from "./files.ts";
import { readableSql, readerSetKeyOf, readerSetOf } from "./reader-sets.ts";
import { indexWords } from "./words.ts";

// Sources and their versions. A source is an identity its host gives;
// each change its producer adds is a version of it, never written over
// the last: the newest is current, and recall searches it alone, while
// the ones before stay as history. Each version's text is kept whole as a
// file in R2 (files.ts) and in chunks in the store (chunks.ts), whose
// words recall searches.
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

/** An add, with what it is compared by: its file's hash and its readers' key. */
interface Adding {
  readonly added: NewSource;
  readonly hash: string;
  readonly readers: string;
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
 * its chunks and their words, its count on the file, its change, and the
 * source's current pointer, which makes it visible. Run it in one
 * transaction. Answers `undefined` when the file's row is gone (swept
 * since it was noted), noting it again for the sweep to find what the add
 * wrote.
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
  for (const [position, chunk] of chunksOf(added.text).entries()) {
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
  db.insert(currentVersions)
    .values({ source: added.source, versionRow: row })
    .onConflictDoUpdate({
      target: currentVersions.source,
      set: { versionRow: row },
    })
    .run();
  return { source: added.source, version };
};

/**
 * Adds `added` as a version of its source, or answers with the version it
 * already is (above): the file first, then the version whole. So an add
 * can be repeated after a lost reply, or after a crash between the file
 * and the version, which it then finishes.
 */
export const addVersion = async (
  { storage, db, bucket }: SourcesStore,
  added: NewSource
): Promise<SourceVersionRef> => {
  const body = encoder.encode(added.text);
  const adding: Adding = {
    added,
    hash: await hashOf(body),
    readers: readerSetKeyOf(added.access),
  };
  const before = madeBefore(db, adding);
  if (before !== undefined) {
    return before;
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
    throw new Error("The Brain lost the file while adding it: add it again");
  }
  return recorded;
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
  const file = await bucket.get(fileKeyOf(found.file));
  if (file === null) {
    throw new Error("The Brain's file of a version is missing");
  }
  return {
    source,
    version,
    text: await file.text(),
    addedAt: new Date(found.added_at),
  };
};
