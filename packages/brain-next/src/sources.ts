import { log } from "@grasp-os/shared/log";
import { and, eq, max } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import type { BrainBucket } from "./bucket.ts";
import { placeChunks } from "./chunk-blocks.ts";
import { chunksOf } from "./chunks.ts";
import {
  changeTaken,
  erasedSource,
  restoringNow,
  staleVersion,
} from "./contract.ts";
import type {
  AddedVersion,
  ChangeRequest,
  CurrentRequest,
  NewSource,
  ReadableRequest,
  ReadersChange,
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
import { enqueueEmbedding } from "./embedding.ts";
import {
  groupOfSource,
  isErased,
  isThread,
  isUnderErasedGroup,
  keepGroup,
  keepSubject,
  subjectOf,
  subjectsOver,
} from "./erasure.ts";
import {
  enqueueExtraction,
  enqueueExtractionIfDue,
  isExtracted,
  queuedExtractOf,
} from "./extraction.ts";
import {
  fileKeyOf,
  hashOf,
  releaseVectors,
  holdFile,
  isHeld,
  isInDoubt,
  noteWrite,
} from "./files.ts";
import { judgeVersion } from "./quotes.ts";
import {
  addsReaders,
  readableSql,
  readerSetKeyOf,
  readerSetOf,
} from "./reader-sets.ts";
import { refuseRemoved } from "./removal.ts";
import { isRestoring } from "./restoring.ts";
import { removeVectorsOf } from "./vectors.ts";
import { indexWords } from "./words.ts";
import type { WordMemo } from "./words.ts";

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
  readonly bucket: BrainBucket;
  /** Whether it may hold groups: a person's own store; the shared one never. */
  readonly groups: boolean;
}

const encoder = new TextEncoder();

/**
 * An add, with what it is compared by (its file's hash and its readers'
 * key), and its chunks when its text is indexed for recall: an
 * instruction file's never is (contract.ts `addInstructions`).
 */
interface Adding {
  /** The add, and the current version it expects when it names one. */
  readonly added: NewSource & { readonly after?: number | null };
  /** The source's key as the erasure ledger names it (erasure.ts). */
  readonly subject: string;
  /** Its group's key as the erasure ledger names it: null for none. */
  readonly group: string | null;
  /** The keys its key lies under, as the ledger names them (`subjectsOver`). */
  readonly over: readonly string[];
  readonly hash: string;
  readonly readers: string;
  /** Its chunks when it is indexed, each with its text's SHA-256: none when not. */
  readonly chunks: readonly { text: string; hash: string }[];
}

/** What an add answers that names another group than its source's first. */
const otherGroup =
  "The Brain refused it: a source keeps the group it was first added in";

/** What an add answers that says otherwise than its source's first whether it is a thread. */
const otherThread =
  "The Brain refused it: a source keeps whether it is a thread, as its first version said";

/**
 * Refuses `adding` when its group's key was erased, or a group its key
 * lies under was (`isUnderErasedGroup`, named or not: as an erased key's
 * add, `erasedSource`), or when its source was first added in another group,
 * or in none: a source keeps its group for good, so a group's erasure
 * finds every version of it.
 */
const refuseByGroup = (sql: SqlStorage, adding: Adding): void => {
  if (
    (adding.group !== null && isErased(sql, adding.group)) ||
    isUnderErasedGroup(sql, adding.over)
  ) {
    throw new Error(erasedSource);
  }
  const held = groupOfSource(sql, adding.added.source);
  if (held !== undefined && held !== adding.group) {
    throw new Error(otherGroup);
  }
  const thread = isThread(sql, adding.added.source);
  if (thread !== undefined && thread !== (adding.added.thread === true)) {
    throw new Error(otherThread);
  }
};

/** A version, as an add finds it: its row, number, file and readers' key. */
const versionFields = {
  row: sourceVersions.row,
  version: sourceVersions.version,
  file: sourceVersions.file,
  readers: readerSets.key,
};

/** When `added`'s text was read, as a change row keeps it, if it said. */
const readAtOf = (added: NewSource): { readAt?: Date } =>
  added.readAt === undefined ? {} : { readAt: new Date(added.readAt) };

/**
 * The version `adding` already made or matches, by the order above,
 * keeping a new change's key for the current version it matches; or
 * `undefined` when it is a new version. Throws when its change was added
 * before with other text or readers.
 *
 * An add over an expected version (`after`) never matches the current
 * one: it always makes a new version, so landing moves the version, and a
 * writer that read the version before it is refused as stale. Matching
 * would let a decision "land" without moving it, and an older writer's
 * `after` still pass over it.
 */
const madeBefore = (
  db: DrizzleSqliteDODatabase,
  storage: DurableObjectStorage,
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
      throw new Error(changeTaken);
    }
    // Sent over a version at or past the one it made: no repeat of that
    // add, which was over an earlier one. Refused as stale, never answered
    // as if it had written.
    if (
      added.after !== undefined &&
      added.after !== null &&
      byChange.version <= added.after
    ) {
      throw new Error(staleVersion);
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
  // Expected to be over another version than the current one: refused,
  // nothing written, before anything else is compared.
  if (added.after !== undefined && (current?.version ?? null) !== added.after) {
    throw new Error(staleVersion);
  }
  if (
    current === undefined ||
    added.after !== undefined ||
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
      ...readAtOf(added),
    })
    .run();
  // A new change asking for memories of a version an earlier add kept
  // without: drawn now, unless drawn already or under way.
  if (added.extract !== undefined) {
    enqueueExtractionIfDue(
      storage,
      added.source,
      current.version,
      added.extract
    );
  }
  return { source: added.source, version: current.version };
};

/**
 * The source's current version when its text was last read later than
 * `added`'s (each says when it was read: the latest `read_at` among the
 * current version's changes, `readAtOf`), marked `newer`: then `added` is
 * written nowhere. A later read of the current text is a change of the
 * current version (`madeBefore`), so it counts too.
 */
const newerThan = (
  db: DrizzleSqliteDODatabase,
  added: NewSource
): AddedVersion | undefined => {
  if (added.readAt === undefined) {
    return undefined;
  }
  const current = db
    .select({
      version: sourceVersions.version,
      readAt: max(sourceChanges.readAt),
    })
    .from(currentVersions)
    .innerJoin(
      sourceVersions,
      eq(sourceVersions.row, currentVersions.versionRow)
    )
    .innerJoin(
      sourceChanges,
      eq(sourceChanges.versionRow, currentVersions.versionRow)
    )
    .where(eq(currentVersions.source, added.source))
    .groupBy(sourceVersions.version)
    .get();
  const lastRead = current?.readAt ?? undefined;
  return current !== undefined &&
    lastRead !== undefined &&
    lastRead.getTime() > added.readAt
    ? { source: added.source, version: current.version, newer: true }
    : undefined;
};

/**
 * Writes the next version of `adding.added.source`, whole: the version,
 * its chunks and their words when it is indexed, with an item on the
 * queue to embed them (embedding.ts), its count on the file,
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
): AddedVersion | undefined => {
  // Erased while this add wrote its file: closed for good, writing nothing
  // (its file is left to the sweep). A restore is under way
  // (restoring.ts): nothing is added meanwhile.
  if (isRestoring(storage.sql)) {
    throw new Error(restoringNow);
  }
  if (isErased(storage.sql, adding.subject)) {
    throw new Error(erasedSource);
  }
  // Removed while this add wrote its file: closed, its history kept.
  refuseRemoved(storage.sql, adding.added.source);
  refuseByGroup(storage.sql, adding);
  // The same change, or the same text and readers, added meanwhile.
  const before = madeBefore(db, storage, adding);
  if (before !== undefined) {
    return before;
  }
  const { added, hash } = adding;
  // Read before the current version was: a late add of an older read
  // never replaces a newer one. Checked here, in the transaction that
  // would make it current, so no other add slips in between.
  const newer = newerThan(db, added);
  if (newer !== undefined) {
    return newer;
  }
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
  // A number names one version for good, so nothing that holds an old
  // one (a late vector put, a citation) ever meets new text under it: only
  // an erasure deletes a version, and it closes the source's key.
  const version = (last?.version ?? 0) + 1;
  const readerSet = readerSetOf(db, added.access);
  const { row } = db
    .insert(sourceVersions)
    .values({
      source: added.source,
      version,
      file: hash,
      readerSet,
      addedAt: new Date(),
    })
    .returning({ row: sourceVersions.row })
    .get();
  // Each word as written is stemmed once per add, however many chunks hold it.
  const memo: WordMemo = new Map();
  // In its set of readers' own block (chunk-blocks.ts).
  const first = placeChunks(storage.sql, readerSet, adding.chunks.length);
  for (const [position, chunk] of adding.chunks.entries()) {
    const written = db
      .insert(chunks)
      .values({
        row: first + position,
        versionRow: row,
        position,
        text: chunk.text,
        hash: chunk.hash,
      })
      .returning({ row: chunks.row })
      .get();
    indexWords(storage.sql, written.row, chunk.text, memo);
  }
  if (adding.chunks.length > 0) {
    // Embedded through the queue, put on it with the chunks: no crash
    // leaves chunks that are never embedded.
    enqueueEmbedding(storage, added.source, version);
    // Memories drawn from it the same way, when its producer said whose
    // words it is.
    if (added.extract !== undefined) {
      enqueueExtraction(storage, added.source, version, added.extract);
    }
  }
  db.insert(sourceChanges)
    .values({
      source: added.source,
      change: added.change,
      versionRow: row,
      ...readAtOf(added),
    })
    .run();
  keepSubject(
    storage.sql,
    added.source,
    adding.subject,
    adding.group,
    added.thread === true
  );
  if (adding.group !== null) {
    keepGroup(storage.sql, adding.group);
  }
  // The version before stops being found by meaning as it stops being
  // current: its chunks' vector codes go with the pointer.
  const replaced = db
    .select({
      versionRow: currentVersions.versionRow,
      judgedRow: currentVersions.judgedRow,
      version: sourceVersions.version,
    })
    .from(currentVersions)
    .innerJoin(
      sourceVersions,
      eq(sourceVersions.row, currentVersions.versionRow)
    )
    .where(eq(currentVersions.source, added.source))
    .get();
  if (replaced !== undefined) {
    removeVectorsOf(storage.sql, replaced.versionRow);
  }
  // Its memories judged against it as it becomes current, the text in
  // hand, and marked judged with the pointer (quotes.ts).
  db.insert(currentVersions)
    .values({ source: added.source, versionRow: row, judgedRow: row })
    .onConflictDoUpdate({
      target: currentVersions.source,
      set: { versionRow: row, judgedRow: row },
    })
    .run();
  judgeVersion(storage.sql, {
    source: added.source,
    version,
    text: added.text,
    replaced:
      replaced === undefined
        ? undefined
        : {
            version: replaced.version,
            judged: replaced.judgedRow === replaced.versionRow,
          },
  });
  if (replaced !== undefined) {
    // Their full vectors too, once no current chunk holds their text: the
    // sweep checks and deletes (files.ts).
    releaseVectors(
      storage.sql,
      JSON.stringify(
        storage.sql
          .exec<{ hash: string | null }>(
            "SELECT hash FROM chunks WHERE version_row = ? AND hash IS NOT NULL",
            replaced.versionRow
          )
          .toArray()
          .map((chunk) => chunk.hash)
      )
    );
  }
  return { source: added.source, version };
};
/**
 * When the version `ref` was added: what an add answers beside it, the
 * same however often its change is repeated. Refused once that version is
 * gone (erased meanwhile).
 */
export const versionAddedAt = (
  db: DrizzleSqliteDODatabase,
  { source, version }: SourceVersionRef
): Date => {
  const found = db
    .select({ addedAt: sourceVersions.addedAt })
    .from(sourceVersions)
    .where(
      and(
        eq(sourceVersions.source, source),
        eq(sourceVersions.version, version)
      )
    )
    .get();
  if (found === undefined) {
    throw new Error("The Brain no longer holds that version");
  }
  return found.addedAt;
};

/** What an add that must be made again says: the same words as a lost file's. */
const addAgain = "The Brain lost the file while adding it: add it again";

/**
 * Adds `added` as a version of its source, or answers with the version it
 * already is (above): the file first, then the version whole. So an add
 * can be repeated after a lost reply, or after a crash between the file
 * and the version, which it then finishes. Its text is cut into chunks
 * and indexed for recall when `indexed`; otherwise it is only kept whole.
 * With `after`, only over that current version (`staleVersion` otherwise),
 * asked again in the transaction that writes.
 */
export const addVersion = async (
  { storage, db, bucket, groups }: SourcesStore,
  added: Adding["added"],
  { indexed }: { indexed: boolean }
): Promise<AddedVersion> => {
  const body = encoder.encode(added.text);
  const adding: Adding = {
    added,
    subject: await subjectOf(added.source),
    group: added.group === undefined ? null : await subjectOf(added.group),
    // The shared store holds no group: nothing under one to look up.
    over: groups ? await subjectsOver(added.source) : [],
    hash: await hashOf(body),
    readers: readerSetKeyOf(added.access),
    chunks: await Promise.all(
      (indexed ? chunksOf(added.text) : []).map(async (text) => ({
        text,
        hash: await hashOf(encoder.encode(text)),
      }))
    ),
  };
  if (isErased(storage.sql, adding.subject)) {
    throw new Error(erasedSource);
  }
  // Before its change is looked up: a retry of an add made before the
  // removal is refused too.
  refuseRemoved(storage.sql, added.source);
  refuseByGroup(storage.sql, adding);
  if (isRestoring(storage.sql)) {
    throw new Error(restoringNow);
  }
  const before = madeBefore(db, storage, adding);
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

/**
 * The text of a version's file, under its hash `file`: null when the file
 * is gone. Only a restore of the store brings back a version whose file
 * the sweep deleted (erasure.ts replays the ledger then): it reads as
 * missing, never failing a read of others.
 */
const textOf = async (
  bucket: BrainBucket,
  file: string
): Promise<string | null> => {
  const object = await bucket.get(fileKeyOf(file));
  if (object === null) {
    // One fixed event and no ids, so a file deleted by mistake is noticed
    // and nothing of what it held is told.
    log.warn("brain.version_file_missing", {});
    return null;
  }
  return await object.text();
};

/**
 * `?1` the source, `?2` the reader's person, `?3` their groups (JSON), `?4`
 * the version: its file and when it was added, if no erasure hid it and
 * the reader is among that version's readers and the source's current
 * version's. So
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
  AND row NOT IN (SELECT version_row FROM erasing_versions)
  AND reader_set IN (SELECT reader_set FROM readable)
  AND EXISTS (
    SELECT 1 FROM current_versions
    JOIN source_versions AS current ON current.row = current_versions.version_row
    WHERE current_versions.source = ?1
      AND current.reader_set IN (SELECT reader_set FROM readable)
  )`;

/** `?1` the source, `?4` the change: the version it made, by `versionSql`'s rule. */
const changeVersionSql = `
WITH ${readableSql}
SELECT version.version AS version FROM source_changes AS change
JOIN source_versions AS version ON version.row = change.version_row
WHERE change.source = ?1 AND change.change = ?4
  AND version.row NOT IN (SELECT version_row FROM erasing_versions)
  AND version.reader_set IN (SELECT reader_set FROM readable)
  AND EXISTS (
    SELECT 1 FROM current_versions
    JOIN source_versions AS current ON current.row = current_versions.version_row
    WHERE current_versions.source = ?1
      AND current.reader_set IN (SELECT reader_set FROM readable)
  )`;

/**
 * The version the change `change` of `source` made: `null` when it made
 * none or `reader` may not read it (as `readVersion`), alike.
 */
export const changeVersion = (
  { storage }: Pick<SourcesStore, "storage">,
  { source, change, reader }: ChangeRequest
): number | null =>
  storage.sql
    .exec<{ version: number }>(
      changeVersionSql,
      source,
      reader.person,
      JSON.stringify(reader.groups),
      change
    )
    .toArray()
    .at(0)?.version ?? null;

/**
 * A version of a source, current or history, whole from its file:
 * `null` when there is none or `reader` may not read it (above), alike.
 */
export const readVersion = async (
  { storage, bucket }: SourcesStore,
  { source, version, reader }: VersionRequest
): Promise<SourceVersion | null> => {
  const stillReadable = () =>
    storage.sql
      .exec<{ file: string; added_at: number }>(
        versionSql,
        source,
        reader.person,
        JSON.stringify(reader.groups),
        version
      )
      .toArray()
      .at(0);
  const found = stillReadable();
  if (found === undefined) {
    return null;
  }
  const text = await textOf(bucket, found.file);
  // Asked again once the file is read: an erasure or a narrowing of the
  // source may have landed while it was.
  return text === null || !stillReadable()
    ? null
    : { source, version, text, addedAt: new Date(found.added_at) };
};

/**
 * `?1` the versions (JSON, each `[source, version]`), `?2` the reader's
 * person, `?3` their groups (JSON): of those, each the reader may read
 * now, by `versionSql`'s rule, in the order given.
 */
const readableVersionsSql = `
WITH ${readableSql}
SELECT version.source AS source, version.version AS version
FROM json_each(?1) AS asked
JOIN source_versions AS version
  ON version.source = asked.value ->> 0 AND version.version = asked.value ->> 1
WHERE version.row NOT IN (SELECT version_row FROM erasing_versions)
  AND version.reader_set IN (SELECT reader_set FROM readable)
  AND EXISTS (
    SELECT 1 FROM current_versions
    JOIN source_versions AS current ON current.row = current_versions.version_row
    WHERE current_versions.source = version.source
      AND current.reader_set IN (SELECT reader_set FROM readable)
  )
ORDER BY asked.key`;

/**
 * Of `versions`, those `reader` may read now, as `readVersion` decides
 * it, in the order given and each once: one statement, no file read.
 */
export const readableVersions = (
  { storage }: SourcesStore,
  { versions, reader }: ReadableRequest
): SourceVersionRef[] => {
  const asked = [
    ...new Map(
      versions.map(({ source, version }) => [
        JSON.stringify([source, version]),
        [source, version] as const,
      ])
    ).values(),
  ];
  return storage.sql
    .exec<{ source: string; version: number }>(
      readableVersionsSql,
      JSON.stringify(asked),
      reader.person,
      JSON.stringify(reader.groups)
    )
    .toArray()
    .map(({ source, version }) => ({ source, version }));
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
 * order given: leaving out each that doesn't exist, each `reader` may
 * not read and each whose file is gone, alike.
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
  const read = await Promise.all(
    found.map(async ({ source, version, file, added_at: addedAt }) => {
      const text = await textOf(bucket, file);
      return text === null
        ? []
        : [{ source, version, text, addedAt: new Date(addedAt) }];
    })
  );
  // Asked again once every file is read: only versions still current and
  // readable now are answered, so an erasure or a new version that landed
  // meanwhile is never read past.
  const now = new Set(
    storage.sql
      .exec<{ source: string; version: number }>(
        currentSql,
        JSON.stringify(sources),
        reader.person,
        JSON.stringify(reader.groups)
      )
      .toArray()
      .map(({ source, version }) => JSON.stringify([source, version]))
  );
  return read
    .flat()
    .filter(({ source, version }) =>
      now.has(JSON.stringify([source, version]))
    );
};

/** What a change of readers answers when the text it would keep is gone. */
const textLost =
  "The Brain lost the text of the version whose readers it would change";

/**
 * The version of `source` the change `change` made, if any, else its
 * current one: its number, file and readers' key.
 */
const versionToKeep = (
  db: DrizzleSqliteDODatabase,
  source: string,
  change: string
):
  | {
      made: boolean;
      row: number;
      version: number;
      file: string;
      readers: string;
    }
  | undefined => {
  const made = db
    .select(versionFields)
    .from(sourceChanges)
    .innerJoin(sourceVersions, eq(sourceVersions.row, sourceChanges.versionRow))
    .innerJoin(readerSets, eq(readerSets.id, sourceVersions.readerSet))
    .where(
      and(eq(sourceChanges.source, source), eq(sourceChanges.change, change))
    )
    .get();
  if (made !== undefined) {
    return { made: true, ...made };
  }
  const current = db
    .select(versionFields)
    .from(currentVersions)
    .innerJoin(
      sourceVersions,
      eq(sourceVersions.row, currentVersions.versionRow)
    )
    .innerJoin(readerSets, eq(readerSets.id, sourceVersions.readerSet))
    .where(eq(currentVersions.source, source))
    .get();
  return current === undefined ? undefined : { made: false, ...current };
};

/**
 * Gives `source` other readers (contract.ts `changeReaders`): a new
 * version with the text of the version its change made, if it made one
 * (a repeat, which `addVersion` answers with that version), else of the
 * current one, over that version (`after`), so an add that lands while
 * the text is read is never undone: the change is then made again over
 * it. Readers the current version already has answer with it and
 * record the change on it, with when it was read, and no new version:
 * decided without an await, so it holds as answered.
 */
export const changeReaders = async (
  store: SourcesStore,
  { source, change, access, readAt, extract }: ReadersChange
): Promise<AddedVersion | null> => {
  for (;;) {
    const kept = versionToKeep(store.db, source, change);
    if (kept === undefined) {
      return null;
    }
    if (!kept.made && kept.readers === readerSetKeyOf(access)) {
      // The current version is this change too, and keeps when it was
      // read, so a later change read before it is refused as older
      // (`newerThan`), as when an add matches the current version
      // (`madeBefore`). Without an await since it was read: still current.
      store.db
        .insert(sourceChanges)
        .values({
          source,
          change,
          versionRow: kept.row,
          ...(readAt === undefined ? {} : { readAt: new Date(readAt) }),
        })
        .run();
      return { source, version: kept.version };
    }
    // Drawn again only when it needs it (contract.ts `changeReaders`): as
    // the caller says, or as the queue was drawing the source.
    const drawing = extract ?? queuedExtractOf(store.storage, source);
    const draws =
      drawing !== undefined &&
      !kept.made &&
      (!isExtracted(store.storage, source, kept.version) ||
        addsReaders(kept.readers, access));
    // oxlint-disable-next-line no-await-in-loop -- again only after another add
    const text = await textOf(store.bucket, kept.file);
    if (text === null) {
      throw new Error(textLost);
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- again only after another add
      return await addVersion(
        store,
        {
          source,
          change,
          text,
          access,
          ...(isThread(store.storage.sql, source) === true
            ? { thread: true }
            : {}),
          ...(readAt === undefined ? {} : { readAt }),
          ...(kept.made ? {} : { after: kept.version }),
          ...(draws ? { extract: drawing } : {}),
        },
        { indexed: true }
      );
    } catch (error) {
      if (
        kept.made ||
        !(error instanceof Error) ||
        error.message !== staleVersion
      ) {
        throw error;
      }
    }
  }
};
