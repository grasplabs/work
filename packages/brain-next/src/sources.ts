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
  sourceVersions,
} from "./db/schema.ts";
import {
  fileGraceMs,
  fileKeyOf,
  hashOf,
  holdFile,
  isHeld,
  noteWrite,
  sweepBy,
} from "./files.ts";
import { readableSql, readerSetKeyOf, readerSetOf } from "./reader-sets.ts";
import { indexWords } from "./words.ts";

// Sources and their versions. A source is an identity its producer gives;
// each add of new content (or new readers) is a new version of it, never
// written over the last: the newest is current, and recall searches it
// alone, while the ones before stay as history. Each version's text is
// kept whole as a file in R2 (files.ts) and in chunks in the store
// (chunks.ts), whose words recall searches.

/** The store's own parts an add or a read needs. */
export interface SourcesStore {
  readonly storage: DurableObjectStorage;
  readonly db: DrizzleSqliteDODatabase;
  readonly bucket: R2Bucket;
}

const encoder = new TextEncoder();

/**
 * The version of `source` that is current and holds the file `hash` for
 * the readers keyed `readers`, if there is one.
 */
const sameAsCurrent = (
  db: DrizzleSqliteDODatabase,
  source: string,
  hash: string,
  readers: string
): number | undefined =>
  db
    .select({ version: sourceVersions.version })
    .from(currentVersions)
    .innerJoin(
      sourceVersions,
      eq(sourceVersions.row, currentVersions.versionRow)
    )
    .innerJoin(readerSets, eq(readerSets.id, sourceVersions.readerSet))
    .where(
      and(
        eq(currentVersions.source, source),
        eq(sourceVersions.file, hash),
        eq(readerSets.key, readers)
      )
    )
    .get()?.version;

/**
 * Writes the next version of `added.source`, whole: the version, its
 * chunks and their words, its count on the file, and the source's current
 * pointer, which makes it visible. Run it in one transaction. Answers
 * `undefined` when the file's row is gone (swept since it was noted),
 * noting it again for the sweep to find what the add wrote.
 */
const record = (
  db: DrizzleSqliteDODatabase,
  storage: DurableObjectStorage,
  { source, text, access }: NewSource,
  hash: string,
  bytes: number
): SourceVersionRef | undefined => {
  // An add of the same, done meanwhile.
  const same = sameAsCurrent(db, source, hash, readerSetKeyOf(access));
  if (same !== undefined) {
    return { source, version: same };
  }
  if (!holdFile(db, hash)) {
    noteWrite(db, hash, bytes);
    return undefined;
  }
  const last = db
    .select({ version: max(sourceVersions.version) })
    .from(sourceVersions)
    .where(eq(sourceVersions.source, source))
    .get();
  const version = (last?.version ?? 0) + 1;
  const { row } = db
    .insert(sourceVersions)
    .values({
      source,
      version,
      file: hash,
      readerSet: readerSetOf(db, access),
      addedAt: new Date(),
    })
    .returning({ row: sourceVersions.row })
    .get();
  for (const [position, chunk] of chunksOf(text).entries()) {
    const written = db
      .insert(chunks)
      .values({ versionRow: row, position, text: chunk })
      .returning({ row: chunks.row })
      .get();
    indexWords(storage.sql, written.row, chunk);
  }
  db.insert(currentVersions)
    .values({ source, versionRow: row })
    .onConflictDoUpdate({
      target: currentVersions.source,
      set: { versionRow: row },
    })
    .run();
  return { source, version };
};

/**
 * Adds `added` as the next version of its source: the file first, then
 * the version whole. The same text and readers as the current version add
 * nothing and answer with it, so an add can be repeated after a lost
 * reply, or after a crash between the file and the version, which it
 * then finishes.
 */
export const addVersion = async (
  { storage, db, bucket }: SourcesStore,
  added: NewSource
): Promise<SourceVersionRef> => {
  const body = encoder.encode(added.text);
  const hash = await hashOf(body);
  const same = sameAsCurrent(
    db,
    added.source,
    hash,
    readerSetKeyOf(added.access)
  );
  if (same !== undefined) {
    return { source: added.source, version: same };
  }
  if (!isHeld(db, hash)) {
    noteWrite(db, hash, body.byteLength);
    await sweepBy(storage, Date.now() + fileGraceMs);
    // R2 checks the bytes against the hash as it takes them.
    await bucket.put(fileKeyOf(hash), body, {
      sha256: hash,
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
  }
  const recorded = storage.transactionSync(() =>
    record(db, storage, added, hash, body.byteLength)
  );
  if (recorded === undefined) {
    await sweepBy(storage, Date.now() + fileGraceMs);
    throw new Error("The Brain lost the file while adding it: add it again");
  }
  return recorded;
};

/**
 * `?1` the source, `?2` the reader's person, `?3` their groups (JSON), `?4`
 * the version: its file and when it was added, if the reader may read it.
 */
const versionSql = `
WITH ${readableSql}
SELECT file, added_at FROM source_versions
WHERE source = ?1 AND version = ?4
  AND reader_set IN (SELECT reader_set FROM readable)`;

/**
 * A version of a source, current or history, whole from its file:
 * `null` when there is none or `reader` may not read it, alike.
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
