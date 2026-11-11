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
// bucket (`erasures/`), whose key says when, the kind, the reason, and
// the SHA-256 of the source's key or the person's id. A person's erasure
// holds, as the object's body, exactly what it hid: the versions by
// number under each source's SHA-256. No content, no plain id. Entries
// are never deleted: a copy of the store of any age can come back.
//
// The order, so a crash at any point serves nothing erased and loses no
// erasure:
//
// 1. In one transaction: the erasure recorded in the store, unconfirmed,
//    and everything it covers hidden: listed in `erasing_versions`, which
//    history leaves out, their change keys gone, and, where a source's
//    current version is among them, its current pointer and queued work.
//    A person's erasure works out what it covers here, in the same
//    transaction, so nothing added meanwhile slips between.
// 2. The ledger entry is written, and the erasure confirmed. If R2 fails
//    or doesn't answer, the erasure fails to its caller, who tries again
//    (the same entry is written again, nothing new); and every tick tries
//    to write each unconfirmed entry until it is in (`confirmPending`).
// 3. The versions are deleted, a version a transaction (`eraseBatch`): a
//    batch by the erasure itself, the rest by the tick. Vector codes first
//    (they point at chunks), each block that held one repacked, then the
//    chunks (the word indexes delete theirs, migration 0006), change keys,
//    the version, its count on its file, and its set of readers once
//    nothing points at it. A version that fails goes behind the others.
//
// After a restore (an older copy of the store coming back, its record of
// erasures with it) the store, as it starts and before it answers
// anything, reads the ledger from the last entry its copy confirmed and
// applies what it lacks, literally: a source's entry hides every version
// of that source and closes its key; a person's hides the versions it
// names, nothing worked out again from the older copy's readers. A store
// that can't read its ledger answers nothing but its overview (store.ts).
//
// An erased source's key stays closed: an add to it is refused, checked
// again in the transaction that would record it (sources.ts). So is an
// add for a person alone that began before that person's erasure and
// lands after it. What is added for them after the erasure is new and
// kept.
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

/** A person's erasure's versions, by number, under each source's subject. */
type Hidden = Record<string, number[]>;

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
 * Most chunks one batch deletes, with their words, stems and vector
 * codes: whole versions, at least one. A first guess, well inside what
 * one transaction of the store should hold it for.
 */
export const eraseChunksPerBatch = 1000;

/** Most unconfirmed entries a tick writes to the ledger. */
const confirmPerTick = 100;

const timeOf = (at: number): string => String(at).padStart(timeDigits, "0");

/** `entry`'s key in the ledger. */
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

const subjectPattern = /^[0-9a-f]{64}$/u;

/** A person's entry's body as the ledger holds it: none when it isn't one. */
const hiddenOf = (body: string | null): Hidden | undefined => {
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(body ?? "");
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const hidden: Hidden = {};
  for (const [subject, versions] of Object.entries(parsed)) {
    if (
      !subjectPattern.test(subject) ||
      !Array.isArray(versions) ||
      !versions.every((version) => Number.isSafeInteger(version))
    ) {
      return undefined;
    }
    hidden[subject] = versions.map(Number);
  }
  return hidden;
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
 * Where the store's record of erasures is now: an add notes it as it
 * begins, so an erasure recorded after that is known by its place, not by
 * a clock (`isPersonErasedSince`).
 */
export const erasuresSoFar = (sql: SqlStorage): number =>
  sql
    .exec<{ last: number }>(
      "SELECT coalesce(max(rowid), 0) AS last FROM erasures"
    )
    .one().last;

/**
 * Whether the person whose id's subject is `subject` was erased since
 * `soFar` (`erasuresSoFar`): an add for them alone that began then is
 * refused, as it may have missed the erasure (sources.ts).
 */
export const isPersonErasedSince = (
  sql: SqlStorage,
  subject: string,
  soFar: number
): boolean =>
  sql
    .exec(
      `SELECT 1 FROM erasures
      WHERE kind = 'person' AND subject = ? AND rowid > ? LIMIT 1`,
      subject,
      soFar
    )
    .toArray().length > 0;

/**
 * Keeps `source`'s subject, as its first version is recorded, in the
 * caller's transaction.
 */
export const keepSubject = (
  sql: SqlStorage,
  source: string,
  subject: string
): void => {
  sql.exec(
    "INSERT OR IGNORE INTO source_subjects (source, subject) VALUES (?, ?)",
    source,
    subject
  );
};

/**
 * Keeps the subject of every source recorded before subjects were kept
 * (migration 0006), once: run as the store starts. A store has none left
 * after its first start on this release, so it costs one lookup after.
 */
export const keepMissingSubjects = async (
  storage: DurableObjectStorage
): Promise<void> => {
  const missing = storage.sql
    .exec<{ source: string }>(
      `SELECT DISTINCT source FROM source_versions
      WHERE source NOT IN (SELECT source FROM source_subjects)`
    )
    .toArray();
  if (missing.length === 0) {
    return;
  }
  const kept = await Promise.all(
    missing.map(
      async ({ source }) => [source, await subjectOf(source)] as const
    )
  );
  storage.transactionSync(() => {
    for (const [source, subject] of kept) {
      keepSubject(storage.sql, source, subject);
    }
  });
};

/**
 * Hides `rows`, versions of `source`, for the erasure `key`: listed to
 * delete, their change keys gone, and, when the source's current version
 * is among them, the source no longer current and its queued work gone.
 * Answers whether it was.
 */
const hideVersions = (
  sql: SqlStorage,
  source: string,
  rows: readonly number[],
  key: string
): boolean => {
  const listed = JSON.stringify(rows);
  sql.exec(
    `INSERT OR IGNORE INTO erasing_versions (version_row, erasure)
    SELECT value, ? FROM json_each(?)`,
    key,
    listed
  );
  sql.exec(
    `DELETE FROM source_changes
    WHERE source = ? AND version_row IN (SELECT value FROM json_each(?))`,
    source,
    listed
  );
  const current =
    sql
      .exec(
        `SELECT 1 FROM current_versions
        WHERE source = ? AND version_row IN (SELECT value FROM json_each(?))`,
        source,
        listed
      )
      .toArray().length > 0;
  if (current) {
    sql.exec("DELETE FROM current_versions WHERE source = ?", source);
    // Work about a source is keyed by the source's key (work.ts `NewWork`).
    sql.exec("DELETE FROM work_items WHERE key = ?", source);
  }
  return current;
};

/** The rows of `source`'s versions, those numbered `versions` if given. */
const rowsOf = (
  sql: SqlStorage,
  source: string,
  versions?: readonly number[]
): number[] =>
  sql
    .exec<{ row: number }>(
      versions === undefined
        ? "SELECT row FROM source_versions WHERE source = ?1"
        : `SELECT row FROM source_versions WHERE source = ?1
          AND version IN (SELECT value FROM json_each(?2))`,
      source,
      ...(versions === undefined ? [] : [JSON.stringify(versions)])
    )
    .toArray()
    .map(({ row }) => row);

/** The sources whose key's subject is `subject`. */
const sourcesOf = (sql: SqlStorage, subject: string): string[] =>
  sql
    .exec<{ source: string }>(
      "SELECT source FROM source_subjects WHERE subject = ?",
      subject
    )
    .toArray()
    .map(({ source }) => source);

/**
 * What a person's erasure at `at` covers, as it will hide it: every
 * version only `person` may read added by then, and every version of each
 * source whose current version is such. Versions by number under each
 * source's subject.
 */
const coveredFor = (sql: SqlStorage, person: string, at: number): Hidden => {
  const rows = sql
    .exec<{ subject: string; version: number }>(
      `WITH theirs AS (
        SELECT id FROM reader_sets WHERE key = ?1
      ),
      whole AS (
        SELECT source_versions.source AS source FROM source_versions
        JOIN current_versions ON current_versions.version_row = source_versions.row
        WHERE source_versions.reader_set IN (SELECT id FROM theirs)
          AND source_versions.added_at <= ?2
      )
      SELECT source_subjects.subject AS subject, source_versions.version AS version
      FROM source_versions
      JOIN source_subjects ON source_subjects.source = source_versions.source
      WHERE source_versions.source IN (SELECT source FROM whole)
        OR (source_versions.reader_set IN (SELECT id FROM theirs)
          AND source_versions.added_at <= ?2)
      ORDER BY subject, version`,
      readerSetKeyOf({ kind: "owner", person }),
      at
    )
    .toArray();
  const covered: Hidden = {};
  for (const { subject, version } of rows) {
    covered[subject] = [...(covered[subject] ?? []), version];
  }
  return covered;
};

/**
 * Applies the erasure `key` (`entry`, and for a person what it hid): the
 * store's record of it, and everything it covers hidden. Run it in one
 * transaction. Safe to repeat. Answers the sources whose current version
 * it hid, whose work under way is to stop.
 */
const apply = (
  sql: SqlStorage,
  key: string,
  entry: LedgerEntry,
  hidden: Hidden | null,
  confirmed: boolean
): string[] => {
  sql.exec(
    `INSERT OR IGNORE INTO erasures
      (key, kind, subject, reason, erased_at, hidden, confirmed)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    key,
    entry.kind,
    entry.subject,
    entry.reason,
    entry.at,
    hidden === null ? null : JSON.stringify(hidden),
    confirmed ? 1 : 0
  );
  const stopped: string[] = [];
  const named: [string, number[] | undefined][] =
    hidden === null ? [[entry.subject, undefined]] : Object.entries(hidden);
  for (const [subject, versions] of named) {
    for (const source of sourcesOf(sql, subject)) {
      if (hideVersions(sql, source, rowsOf(sql, source, versions), key)) {
        stopped.push(source);
      }
    }
  }
  return stopped;
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

/**
 * `?1` the rows this batch failed (JSON): the next version to erase,
 * those that failed least often first, so one that keeps failing never
 * holds back the others.
 */
const nextErasingSql = `
SELECT source_versions.row AS row, source_versions.source AS source,
  source_versions.file AS file, source_versions.reader_set AS reader_set,
  (SELECT count(*) FROM chunks WHERE chunks.version_row = source_versions.row) AS chunks
FROM erasing_versions
JOIN source_versions ON source_versions.row = erasing_versions.version_row
WHERE erasing_versions.version_row NOT IN (SELECT value FROM json_each(?1))
ORDER BY erasing_versions.failures, erasing_versions.version_row
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

/** How a batch went: whether more are left, and whether any failed. */
export interface Erased {
  more: boolean;
  failed: boolean;
}

/**
 * Deletes the next versions erasures hid, each whole in a transaction of
 * its own, up to about `eraseChunksPerBatch` chunks (at least one
 * version). One that fails stays hidden, is counted, and goes behind the
 * others: the batch goes on with the next, and a later one tries it again.
 */
export const eraseBatch = (storage: DurableObjectStorage): Erased => {
  const { sql } = storage;
  const failed: number[] = [];
  let erased = 0;
  for (;;) {
    const next = sql
      .exec<Erasing>(nextErasingSql, JSON.stringify(failed))
      .toArray()
      .at(0);
    if (next === undefined) {
      return { more: failed.length > 0, failed: failed.length > 0 };
    }
    if (erased > 0 && erased + next.chunks > eraseChunksPerBatch) {
      return { more: true, failed: failed.length > 0 };
    }
    erased += Math.max(1, next.chunks);
    try {
      storage.transactionSync(() => {
        eraseVersion(sql, next);
      });
    } catch {
      // Nothing of the error is kept: the version stays hidden, to try
      // again behind the others.
      failed.push(next.row);
      sql.exec(
        "UPDATE erasing_versions SET failures = failures + 1 WHERE version_row = ?",
        next.row
      );
    }
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

/** How long a write to the ledger, or a page of its listing, is waited for. */
const ledgerWaitMs = 10_000;

/** `promise`, or a rejection once `ledgerWaitMs` is over. */
const inTime = async <T>(promise: Promise<T>): Promise<T> => {
  const { promise: late, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    reject(new Error("The ledger didn't answer in time"));
  }, ledgerWaitMs);
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
};

/** An erasure the store recorded, as its ledger entry is written. */
interface Recorded extends Record<string, SqlStorageValue> {
  key: string;
  hidden: string | null;
}

/** Writes `recorded`'s ledger entry and confirms it: throws if R2 fails. */
const confirm = async (
  { storage, bucket }: ErasureStore,
  { key, hidden }: Recorded
): Promise<void> => {
  await inTime(bucket.put(key, hidden ?? ""));
  storage.sql.exec("UPDATE erasures SET confirmed = 1 WHERE key = ?", key);
};

/**
 * Writes the ledger entries of the erasures the store recorded but hasn't
 * confirmed, the oldest first, at most `confirmPerTick`: an erasure whose
 * write failed, or timed out and may have landed (written again, the
 * same). Throws once one fails, keeping the rest for the next tick.
 */
export const confirmPending = async (store: ErasureStore): Promise<void> => {
  const pending = store.storage.sql
    .exec<Recorded>(
      `SELECT key, hidden FROM erasures WHERE confirmed = 0
      ORDER BY key LIMIT ?`,
      confirmPerTick
    )
    .toArray();
  for (const recorded of pending) {
    // oxlint-disable-next-line no-await-in-loop -- in order, oldest first
    await confirm(store, recorded);
  }
};

/**
 * The next erasure's time: now, or just after the last one recorded, so
 * the ledger's keys only grow whatever the clock does.
 */
const nextAt = (sql: SqlStorage): number => {
  const last = sql
    .exec<{ at: number | null }>("SELECT max(erased_at) AS at FROM erasures")
    .one().at;
  return Math.max(Date.now(), (last ?? 0) + 1);
};

/**
 * Erases `id`, a source's key or a person's id, for `reason` (above):
 * recorded and hidden, then the ledger entry, then one batch deleted.
 * Answers the sources whose current version it hid. A source erased
 * before answers at once, its entry written again if it wasn't confirmed.
 */
export const erase = async (
  store: ErasureStore,
  kind: ErasureKind,
  id: string,
  reason: ErasureReason
): Promise<string[]> => {
  const { storage } = store;
  const { sql } = storage;
  const subject = await subjectOf(id);
  const before =
    kind === "source"
      ? sql
          .exec<Recorded & { confirmed: number }>(
            `SELECT key, hidden, confirmed FROM erasures
            WHERE kind = 'source' AND subject = ? LIMIT 1`,
            subject
          )
          .toArray()
          .at(0)
      : undefined;
  let recorded: Recorded | undefined = before;
  let stopped: string[] = [];
  if (before === undefined) {
    ({ recorded, stopped } = storage.transactionSync(() => {
      if (kind === "source") {
        // The sources an entry names are found by their subject.
        keepSubject(sql, id, subject);
      }
      const at = nextAt(sql);
      const entry: LedgerEntry = { kind, subject, reason, at };
      const key = ledgerKeyOf(entry);
      const hidden = kind === "person" ? coveredFor(sql, id, at) : null;
      return {
        recorded: {
          key,
          hidden: hidden === null ? null : JSON.stringify(hidden),
        },
        stopped: apply(sql, key, entry, hidden, false),
      };
    }));
  } else if (before.confirmed === 1) {
    return [];
  }
  try {
    await confirm(store, recorded ?? { key: "", hidden: null });
  } catch {
    // Recorded and hidden: the tick writes its entry; the caller, told,
    // tries again. Nothing of R2's error: it may name the key.
    throw new Error(notRecorded);
  }
  try {
    eraseBatch(storage);
  } catch {
    // Hidden and recorded: the tick deletes the rest, and shows a failure.
  }
  return stopped;
};

/**
 * Lists the ledger after `startAfter`, a page at a time, each page within
 * `ledgerWaitMs`.
 */
const ledgerKeysAfter = async (
  bucket: R2Bucket,
  startAfter: string | undefined
): Promise<string[]> => {
  const keys: string[] = [];
  let cursor: string | undefined = undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const listed: R2Objects = await inTime(
      bucket.list({
        prefix: ledgerPrefix,
        ...(cursor === undefined ? { startAfter } : { cursor }),
      })
    );
    keys.push(...listed.objects.map(({ key }) => key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return keys;
};

/**
 * Where a replay reads the ledger from: after the last entry of this copy
 * of the store that is confirmed with every entry before it. That mark is
 * part of the store, so it is exactly what this copy has applied: on an
 * ordinary start it is the last entry, and the listing finds nothing new;
 * after a restore the copy's mark is as old as the copy, and the listing
 * finds everything erased since. An entry the store recorded and whose
 * write may still land is never passed: the mark stays before it.
 */
const replayMark = (sql: SqlStorage): string | null =>
  sql
    .exec<{ key: string | null }>(
      `SELECT max(key) AS key FROM erasures WHERE confirmed = 1
      AND key < coalesce((SELECT min(key) FROM erasures WHERE confirmed = 0), '~')`
    )
    .one().key;

/**
 * Applies every entry of the ledger the store hasn't, in order, literally
 * (above), each confirmed as read. Run it as the store starts, before it
 * answers anything. Throws when R2 fails or doesn't answer in time, so
 * the store answers nothing it would need it for (store.ts). Answers the
 * sources whose current version it hid.
 *
 * Measured in local workerd on a laptop, with 100,000 entries in the
 * ledger, each start timed with the first tick it served: an ordinary
 * start, nothing new past its mark, 9 ms; a store with none of them
 * applied (an export restored into an empty store, the worst case),
 * listing and applying all 100,000, 1.7 s, well inside the 30 s a start
 * may hold the store. Not measured on Cloudflare.
 */
export const replayLedger = async ({
  storage,
  bucket,
}: ErasureStore): Promise<string[]> => {
  const { sql } = storage;
  const mark = replayMark(sql);
  const listed = await ledgerKeysAfter(bucket, mark ?? undefined);
  const missing = listed.flatMap((key) => {
    const entry = entryOf(key);
    const applied =
      sql.exec("SELECT 1 FROM erasures WHERE key = ?", key).toArray().length >
      0;
    return entry === undefined || applied ? [] : [{ key, entry }];
  });
  const read = await Promise.all(
    missing.map(async ({ key, entry }) => {
      if (entry.kind === "source") {
        return { key, entry, hidden: null };
      }
      const object = await inTime(bucket.get(key));
      const body = object === null ? null : await object.text();
      const hidden = hiddenOf(body);
      if (hidden === undefined) {
        // Only the store writes the ledger: an entry it can't read is a
        // fault to fix, and the store serves nothing it may have erased.
        throw new Error("An entry of the erasure ledger can't be read");
      }
      return { key, entry, hidden };
    })
  );
  return storage.transactionSync(() =>
    read.flatMap(({ key, entry, hidden }) =>
      apply(sql, key, entry, hidden, true)
    )
  );
};
