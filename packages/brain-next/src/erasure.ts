import { erasureReasons } from "./contract.ts";
import type { ErasureReason } from "./contract.ts";
import { hashOf } from "./files.ts";
import { readerSetKeyOf } from "./reader-sets.ts";
import { removeVectorsOf, repackBlocks } from "./vectors.ts";

// Erasure: what goes for good, apart from ordinary removal. A new version
// of a source ends the one before as history, readable as it was; an
// erasure leaves nothing. It covers one source (`eraseSource`: every
// version) or what one person alone may read (`erasePerson`), and reaches
// every place content is: versions, chunks, their words and stems, vector
// codes and the packed blocks they were in, change keys, queued work, and
// the files in R2, which the sweep deletes once no version holds them
// (files.ts: its grace and its in-doubt rule hold for them as for any).
//
// One ledger records every erasure: an object per erasure in the Brain's
// bucket (`erasures/`), whose key says all it holds: when, the kind, the
// reason, and the SHA-256 of the source's key or the person's id. No
// content, no plain id. A restore of the store (an older copy coming
// back) never touches the bucket, so as the store starts, before it
// answers anything, it reads the ledger from the last entry it applied and
// applies what it lacks (`replayLedger`): what was erased since the copy
// was made is erased again. Entries are never deleted: a copy of any age
// can come back.
//
// The order, so a crash at any point loses nothing and serves nothing
// erased:
//
// 1. The ledger entry is written. A failure here fails the erasure, and
//    the caller tries again.
// 2. In one transaction: the store's own record of the entry, and the
//    content hidden: each erased source's current pointer, change keys and
//    queued work deleted, and its versions listed in `erasing_versions`,
//    which history leaves out. From here nothing erased is found or read.
//    A stop between 1 and 2 is made good by the replay as the store starts.
// 3. The versions are deleted a batch at a time (`eraseBatch`): one batch
//    by the erasure itself, the rest by the tick, each in one transaction,
//    vector codes first (they point at chunks), each block that held one
//    repacked, then the chunks (the word indexes delete theirs, migration
//    0006), change keys, the version, its count on its file, and its set
//    of readers once nothing points at it.
//
// An erased source's key stays closed: its add is refused, checked again
// in the transaction that would record it (sources.ts), so an add under
// way as the erasure lands, or a producer's late retry, never brings it
// back. The same bytes under another source are that source's own.
//
// Nothing an erasure answers depends on what it found: it is recorded
// and answers alike for a source or person that held nothing.

/** The parts of the store an erasure works with. */
export interface ErasureStore {
  readonly storage: DurableObjectStorage;
  readonly bucket: R2Bucket;
}

/** What is erased: a source, or what a person alone may read. */
type ErasureKind = "source" | "person";

/** An erasure, as the ledger holds it. */
interface LedgerEntry {
  kind: ErasureKind;
  /** The SHA-256 of the source's key or the person's id, in hex. */
  subject: string;
  reason: ErasureReason;
  /** When, in milliseconds. */
  at: number;
}

/** Where the ledger's entries are in the bucket. */
const ledgerPrefix = "erasures/";

/** Digits of an entry's time in its key: so keys sort by time. */
const timeDigits = 15;

/**
 * How far before the last entry it applied a store reads the ledger
 * again as it starts: an entry the store didn't apply, written just
 * before others it did (its transaction lost to a crash), is still met.
 */
const replayMarginMs = 24 * 60 * 60_000;

/**
 * Most chunks one batch deletes, with their words, stems and vector
 * codes: whole versions, at least one. A first guess, well inside what
 * one transaction of the store should hold it for.
 */
export const eraseChunksPerBatch = 1000;

const timeOf = (at: number): string => String(at).padStart(timeDigits, "0");

/** `entry`'s key in the ledger: everything it holds. */
const ledgerKeyOf = ({ at, kind, reason, subject }: LedgerEntry): string =>
  `${ledgerPrefix}${timeOf(at)}-${kind}-${reason}-${subject}`;

const ledgerKeyPattern =
  /^erasures\/(?<at>\d{15})-(?<kind>source|person)-(?<reason>[a-z_]+)-(?<subject>[0-9a-f]{64})$/u;

const isReason = (reason: string): reason is ErasureReason =>
  erasureReasons.some((known) => known === reason);

const isKind = (kind: string): kind is ErasureKind =>
  kind === "source" || kind === "person";

/** The entry `key` names: none for a key the ledger never writes. */
const entryOf = (key: string): LedgerEntry | undefined => {
  const groups = ledgerKeyPattern.exec(key)?.groups;
  const { at, kind, reason, subject } = groups ?? {};
  if (
    at === undefined ||
    kind === undefined ||
    reason === undefined ||
    subject === undefined ||
    !isKind(kind) ||
    !isReason(reason)
  ) {
    return undefined;
  }
  return { at: Number(at), kind, reason, subject };
};

const encoder = new TextEncoder();

/** The ledger's name for a source's key or a person's id. */
export const subjectOf = async (id: string): Promise<string> =>
  await hashOf(encoder.encode(id));

/**
 * Whether the source whose key's subject is `subject` was erased: its
 * key is closed (sources.ts asks before an add and as it records one).
 */
export const isErased = (sql: SqlStorage, subject: string): boolean =>
  sql
    .exec(
      "SELECT 1 FROM erasures WHERE kind = 'source' AND subject = ? LIMIT 1",
      subject
    )
    .toArray().length > 0;

/**
 * Hides every version of `source` for the erasure `key`: no longer
 * current, its change keys and queued work gone, its versions to delete.
 */
const hideSource = (sql: SqlStorage, source: string, key: string): void => {
  sql.exec(
    `INSERT OR IGNORE INTO erasing_versions (version_row, erasure)
    SELECT row, ?1 FROM source_versions WHERE source = ?2`,
    key,
    source
  );
  sql.exec("DELETE FROM current_versions WHERE source = ?", source);
  sql.exec("DELETE FROM source_changes WHERE source = ?", source);
  // Work about a source is keyed by the source's key (work.ts `NewWork`).
  sql.exec("DELETE FROM work_items WHERE key = ?", source);
};

/**
 * Hides, for the erasure `key` at `at`, every version only `person` may
 * read added by then: whole each source whose current version is such,
 * and otherwise that version alone, its change keys gone.
 */
const hidePerson = (
  sql: SqlStorage,
  person: string,
  key: string,
  at: number
): void => {
  const set = sql
    .exec<{ id: number }>(
      "SELECT id FROM reader_sets WHERE key = ?",
      readerSetKeyOf({ kind: "owner", person })
    )
    .toArray()
    .at(0);
  if (set === undefined) {
    return;
  }
  const whole = sql
    .exec<{ source: string }>(
      `SELECT source_versions.source AS source FROM source_versions
      JOIN current_versions ON current_versions.version_row = source_versions.row
      WHERE source_versions.reader_set = ? AND source_versions.added_at <= ?`,
      set.id,
      at
    )
    .toArray();
  for (const { source } of whole) {
    hideSource(sql, source, key);
  }
  sql.exec(
    `INSERT OR IGNORE INTO erasing_versions (version_row, erasure)
    SELECT row, ?1 FROM source_versions WHERE reader_set = ?2 AND added_at <= ?3`,
    key,
    set.id,
    at
  );
  sql.exec(
    `DELETE FROM source_changes WHERE version_row IN (
      SELECT version_row FROM erasing_versions WHERE erasure = ?)`,
    key
  );
};

/**
 * Applies the ledger's `key` (`entry`) to `ids`, the sources or people
 * whose subject it names: recorded, and everything it covers hidden. Run
 * it in one transaction. Safe to repeat.
 */
const apply = (
  sql: SqlStorage,
  key: string,
  entry: LedgerEntry,
  ids: readonly string[]
): void => {
  sql.exec(
    `INSERT OR IGNORE INTO erasures (key, kind, subject, reason, erased_at)
    VALUES (?, ?, ?, ?, ?)`,
    key,
    entry.kind,
    entry.subject,
    entry.reason,
    entry.at
  );
  for (const id of ids) {
    if (entry.kind === "source") {
      hideSource(sql, id, key);
    } else {
      hidePerson(sql, id, key, entry.at);
    }
  }
};

/**
 * Deletes the set of readers `readerSet` once nothing points at it: an
 * erased person's id goes with their last version.
 */
const dropUnusedReaderSet = (sql: SqlStorage, readerSet: number): void => {
  const [used] = sql
    .exec<{ used: number }>(
      `SELECT EXISTS (SELECT 1 FROM source_versions WHERE reader_set = ?1)
        OR EXISTS (SELECT 1 FROM vector_models
          JOIN vector_codes ON vector_codes.model = vector_models.id
            AND vector_codes.reader_set = ?1)
        OR EXISTS (SELECT 1 FROM vector_models
          JOIN vector_blocks ON vector_blocks.model = vector_models.id
            AND vector_blocks.reader_set = ?1) AS used`,
      readerSet
    )
    .toArray();
  if (used?.used === 1) {
    return;
  }
  sql.exec("DELETE FROM reader_set_members WHERE reader_set = ?", readerSet);
  sql.exec("DELETE FROM reader_sets WHERE id = ?", readerSet);
};

/** A version still to erase, as a batch takes it. */
interface Erasing extends Record<string, SqlStorageValue> {
  row: number;
  source: string;
  file: string;
  reader_set: number;
  chunks: number;
}

const nextErasingSql = `
SELECT source_versions.row AS row, source_versions.source AS source,
  source_versions.file AS file, source_versions.reader_set AS reader_set,
  (SELECT count(*) FROM chunks WHERE chunks.version_row = source_versions.row) AS chunks
FROM erasing_versions
JOIN source_versions ON source_versions.row = erasing_versions.version_row
ORDER BY erasing_versions.version_row
LIMIT 1`;

/** Deletes `version` and everything it holds, in the caller's transaction. */
const eraseVersion = (sql: SqlStorage, version: Erasing): void => {
  // Codes first: they point at the chunks. Each block that held one is
  // repacked, so none keeps the chunk's row or 1-bit code.
  repackBlocks(sql, removeVectorsOf(sql, version.row));
  // Its words and stems go with each chunk (migration 0006's triggers).
  sql.exec("DELETE FROM chunks WHERE version_row = ?", version.row);
  sql.exec(
    "DELETE FROM source_changes WHERE source = ? AND version_row = ?",
    version.source,
    version.row
  );
  sql.exec("DELETE FROM current_versions WHERE version_row = ?", version.row);
  sql.exec("DELETE FROM erasing_versions WHERE version_row = ?", version.row);
  sql.exec("DELETE FROM source_versions WHERE row = ?", version.row);
  // The sweep deletes the file once no version holds it (files.ts).
  sql.exec("UPDATE files SET refs = refs - 1 WHERE hash = ?", version.file);
  dropUnusedReaderSet(sql, version.reader_set);
};

/**
 * Deletes the next versions erasures hid, whole, up to about
 * `eraseChunksPerBatch` chunks (at least one version). Run it in one
 * transaction. True when more are left.
 */
export const eraseBatch = (sql: SqlStorage): boolean => {
  let erased = 0;
  for (;;) {
    const next = sql.exec<Erasing>(nextErasingSql).toArray().at(0);
    if (next === undefined) {
      return false;
    }
    if (erased > 0 && erased + next.chunks > eraseChunksPerBatch) {
      return true;
    }
    eraseVersion(sql, next);
    erased += Math.max(1, next.chunks);
  }
};

/** How many erasures still hide versions the tick has to delete. */
export const erasuresUnfinished = (sql: SqlStorage): number =>
  sql
    .exec<{ count: number }>(
      "SELECT count(DISTINCT erasure) AS count FROM erasing_versions"
    )
    .one().count;

/** What an erasure says when its ledger entry couldn't be written. */
const notRecorded = "The Brain could not record the erasure: erase it again";

/**
 * Erases `id`, a source's key or a person's id, for `reason` (above): the
 * ledger entry, then the store's record and everything hidden, then one
 * batch deleted. Returns once all but the batches the tick finishes is
 * on disk. A source erased before answers at once, writing nothing.
 */
export const erase = async (
  { storage, bucket }: ErasureStore,
  kind: ErasureKind,
  id: string,
  reason: ErasureReason
): Promise<void> => {
  const subject = await subjectOf(id);
  if (kind === "source" && isErased(storage.sql, subject)) {
    return;
  }
  const entry: LedgerEntry = { kind, subject, reason, at: Date.now() };
  const key = ledgerKeyOf(entry);
  try {
    await bucket.put(key, new Uint8Array(0));
  } catch {
    // Nothing of R2's error: it may name the key.
    throw new Error(notRecorded);
  }
  storage.transactionSync(() => {
    apply(storage.sql, key, entry, [id]);
  });
  try {
    storage.transactionSync(() => eraseBatch(storage.sql));
  } catch {
    // Hidden and recorded: the tick deletes it, and shows the failure.
  }
};

/** Every key of the ledger after `startAfter`, in order. */
const ledgerKeysAfter = async (
  bucket: R2Bucket,
  startAfter: string | undefined
): Promise<string[]> => {
  const keys: string[] = [];
  let cursor: string | undefined = undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const listed: R2Objects = await bucket.list({
      prefix: ledgerPrefix,
      ...(cursor === undefined ? { startAfter } : { cursor }),
    });
    keys.push(...listed.objects.map(({ key }) => key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return keys;
};

/** Each of `ids` by its subject: the ones `subjects` names. */
const bySubject = async (
  ids: readonly string[],
  subjects: ReadonlySet<string>
): Promise<Map<string, string[]>> => {
  const found = new Map<string, string[]>();
  if (subjects.size === 0) {
    return found;
  }
  const hashed = await Promise.all(
    ids.map(async (id) => [await subjectOf(id), id] as const)
  );
  for (const [subject, id] of hashed) {
    if (subjects.has(subject)) {
      found.set(subject, [...(found.get(subject) ?? []), id]);
    }
  }
  return found;
};

/**
 * Applies every entry of the ledger the store hasn't: those written
 * since the copy it holds was made, after a restore, or one whose
 * transaction a crash lost. Reads the ledger from a day before the last
 * entry the store applied. Run it as the store starts, before it answers
 * anything: what it throws (R2 out of reach) fails the start, so a store
 * that can't read its ledger serves nothing.
 */
export const replayLedger = async ({
  storage,
  bucket,
}: ErasureStore): Promise<void> => {
  const { sql } = storage;
  const last = sql
    .exec<{ key: string | null }>("SELECT max(key) AS key FROM erasures")
    .one().key;
  const lastAt = last === null ? undefined : entryOf(last)?.at;
  const startAfter =
    lastAt === undefined
      ? undefined
      : `${ledgerPrefix}${timeOf(Math.max(0, lastAt - replayMarginMs))}`;
  const listed = await ledgerKeysAfter(bucket, startAfter);
  const missing = listed.flatMap((key) => {
    const entry = entryOf(key);
    const applied =
      sql.exec("SELECT 1 FROM erasures WHERE key = ?", key).toArray().length >
      0;
    return entry === undefined || applied ? [] : [{ key, entry }];
  });
  if (missing.length === 0) {
    return;
  }
  const subjects = (kind: ErasureKind) =>
    new Set(
      missing
        .filter(({ entry }) => entry.kind === kind)
        .map(({ entry }) => entry.subject)
    );
  const sources = await bySubject(
    sql
      .exec<{ source: string }>("SELECT DISTINCT source FROM source_versions")
      .toArray()
      .map(({ source }) => source),
    subjects("source")
  );
  const people = await bySubject(
    sql
      .exec<{ principal: string }>(
        "SELECT DISTINCT principal FROM reader_set_members WHERE kind = 'person'"
      )
      .toArray()
      .map(({ principal }) => principal),
    subjects("person")
  );
  storage.transactionSync(() => {
    for (const { key, entry } of missing) {
      const ids =
        (entry.kind === "source" ? sources : people).get(entry.subject) ?? [];
      apply(sql, key, entry, ids);
    }
  });
};
