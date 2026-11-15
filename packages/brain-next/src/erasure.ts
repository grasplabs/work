import { z } from "zod";

import type { BrainBucket } from "./bucket.ts";
import { erasureReasons } from "./contract.ts";
import type {
  ErasureReason,
  ErasureStatus,
  ErasuresOverview,
} from "./contract.ts";
import { hashOf, releaseVectors } from "./files.ts";
import { eraseMemoriesOfSource, eraseMemoriesOn } from "./forget.ts";
import { dropRechecksOf } from "./recheck.ts";
import { removeVectorsOf, repackBlocks } from "./vectors.ts";

// Erasure: what goes for good, apart from ordinary removal. A new version
// of a source ends the one before as history, readable as it was; an
// erasure leaves nothing. It covers one source (`eraseSource`: every
// version, and every version of each source added in its key as a group,
// as a chat's turns are in a person's own store), and reaches every place
// content is: versions, chunks, their words and stems, vector codes and
// the packed blocks they were in, change keys, queued work, and the files
// in R2, which the sweep deletes once no version holds them
// (files.ts: its grace and its in-doubt rule hold for them as for any).
//
// What only one person may read has no erasure here: the shared store
// refuses it as it is added (store.ts `#mayKeep`), and a person's own
// store, which holds only theirs, is erased whole (below).
//
// One ledger records every erasure: an object per erasure in the Brain's
// bucket (`erasures/`), whose key says when, the reason, and the SHA-256
// of the source's key. No content, no plain id. Entries are never
// deleted: a copy of the store of any age can come back.
//
// The order, so a crash serves nothing erased, and an erasure that
// returned is never lost:
//
// 1. In one transaction: the erasure recorded in the store, unconfirmed,
//    and everything it covers hidden: listed in `erasing_versions`, which
//    history leaves out, their vector codes out of the scan, their change
//    keys gone, and, where a source's current version is among them, its
//    current pointer and queued work.
// 2. The ledger entry is written, and the erasure confirmed: only then
//    does the erasure return. If R2 fails or doesn't
//    answer, the erasure fails to its caller, who must try again until it
//    returns (the same entry is written again, nothing new); and every
//    tick tries to write each unconfirmed entry until it is in
//    (`confirmPending`). An erasure that failed is not yet safe: if the
//    store stops before its entry is written and an older copy of it comes
//    back, the erasure is gone with the record of it. Only an erasure that
//    returned is in the ledger.
// 3. The versions are deleted, a version a transaction (`eraseBatch`): a
//    batch by the erasure itself, the rest by the tick. Vector codes first
//    (they point at chunks), each block that held one repacked, then the
//    chunks (the word indexes delete theirs, migration 0006), change keys,
//    the version, its count on its file, and its set of readers once
//    nothing points at it. A version that fails goes behind the others.
//
// After a restore (an older copy of the store coming back, its record of
// erasures with it) the store, as it starts and before it answers
// anything, reads the ledger after the last entry its copy holds and
// applies what it lacks: a source's entry hides every version of that
// source and closes its key. It does so a bounded step at a time
// (`replayStep`), each entry in its own transaction, so a long replay
// goes on where the last step stopped. Until
// it is through, and while it can't read the ledger, the store answers
// nothing but its overview (store.ts).
//
// An erased source's key stays closed: an add to it is refused, checked
// again in the transaction that would record it (sources.ts), and so is
// an add naming it as its group, whatever the add's own key.
//
// Memories go with what they rest on (forget.ts): those drawn from a
// version are hidden with it (memories.ts reads none whose version an
// erasure holds) and deleted with it, and again by the replay at start
// (`replayMemoryErasures`). An entity no
// memory mentions any more goes with them, its names and identifiers
// with it.
//
// Nothing an erasure answers depends on what it found: it is recorded
// and answers alike for a source that held nothing.
//
// What an erasure deletes never frees a name for what comes after it: a
// source's next version is numbered past every one erased (sources.ts),
// and a queued item's id is never used twice (migration 0006), so a late
// vector put, a citation or a handler settling under an old name never
// reaches new content. Reads that wait for a file ask again, after it,
// whether the version may still be read (sources.ts). And no plain key
// outlives what it named: a source's key leaves `source_subjects` with its
// last version, and a set of readers goes with the last row naming it.

/** The parts of the store an erasure works with. */
export interface ErasureStore {
  readonly storage: DurableObjectStorage;
  readonly bucket: BrainBucket;
  /**
   * Whether it may hold groups (a person's own store): only then is a
   * source's erasure marked as a group's in its ledger entry, and only
   * then does a replay read a source entry's body for that mark.
   */
  readonly groups: boolean;
}

/** A source's erasure, as the ledger holds it. */
interface LedgerEntry {
  /** The SHA-256 of the source's key, in hex. */
  subject: string;
  reason: ErasureReason;
  /** When, in milliseconds. */
  at: number;
}

/** Where the ledger's entries are in the bucket. */
export const ledgerPrefix = "erasures/";

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

/**
 * How long a tick starts writing unconfirmed entries for: a slow bucket
 * delays the tick's queue by this and one write's 10 s at most.
 */
const confirmTickMs = 30_000;

/**
 * Most entries of the ledger one step of a replay reads (`replayStep`),
 * in a person's own store, for each source entry's mark of a group
 * (`groupBody`); the shared store reads none, as it holds no group. One
 * at a time. A first guess, well inside the step's time.
 */
export const replayReadsPerStep = 200;

/** Most keys one step of a replay lists: one page of R2's listing. */
const ledgerPageSize = 1000;

/**
 * How long one step of a replay starts new reads, listings and entries
 * for: a read or listing started just before it may take its own 10 s
 * (`ledgerWaitMs`), and applying an entry is checked against it too, so a
 * step's I/O ends within 20 s, leaving 10 s of the 30 s the store may be
 * held for the rest of a start (`migrate`, and `keepMissingSubjects` once
 * after migration 0006).
 */
const replayStepMs = 10_000;

const timeOf = (at: number): string => String(at).padStart(timeDigits, "0");

/** `entry`'s key in the ledger. */
const ledgerKeyOf = ({ at, reason, subject }: LedgerEntry): string =>
  `${ledgerPrefix}${timeOf(at)}-source-${reason}-${subject}`;

const ledgerKeyPattern =
  /^erasures\/(?<at>\d{15})-source-(?<reason>[a-z_]+)-(?<subject>[0-9a-f]{64})$/u;

/**
 * A person's entry, or one of its parts (`<key>/0000` on), as the shared
 * store wrote them until it refused what only one person may read
 * (GRA-1822): a replay passes over them. Nothing released holds one, and
 * a store written since holds nothing such an entry hid; one restored
 * from before keeps what it hid (GRA-1903). Removed once staging's Brain
 * is reset (GRA-1907).
 */
const personEntryPattern =
  /^erasures\/\d{15}-person-[a-z_]+-[0-9a-f]{64}(?:\/\d+)?$/u;

const isReason = (reason: string): reason is ErasureReason =>
  erasureReasons.some((known) => known === reason);

/** The entry `key` names: none for a key the ledger never writes. */
const entryOf = (key: string): LedgerEntry | undefined => {
  const groups = ledgerKeyPattern.exec(key)?.groups;
  const { at, reason, subject } = groups ?? {};
  if (
    at === undefined ||
    reason === undefined ||
    subject === undefined ||
    !isReason(reason)
  ) {
    return undefined;
  }
  return { at: Number(at), reason, subject };
};

/** Thrown when a step of a replay is out of time: no new read starts. */
class OutOfTimeError extends Error {
  constructor() {
    super("A step of the replay is out of time");
    this.name = "OutOfTimeError";
  }
}

const encoder = new TextEncoder();

/** The ledger's name for a source's key. */
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
 * The subject of the group the source `source` was first added in: null
 * for one in none, undefined for a source the store holds no version of.
 */
export const groupOfSource = (
  sql: SqlStorage,
  source: string
): string | null | undefined =>
  sql
    .exec<{ group: string | null }>(
      'SELECT group_subject AS "group" FROM source_subjects WHERE source = ?',
      source
    )
    .toArray()
    .at(0)?.group;

/**
 * The subjects of the keys `key` lies under: each part of it that ends
 * before a "/", as the ledger names them. At most as many as its "/".
 */
export const subjectsOver = async (key: string): Promise<string[]> =>
  await Promise.all(
    [...key.matchAll(/\//gu)].map(
      async ({ index }) => await subjectOf(key.slice(0, index))
    )
  );

/**
 * Whether a key lies under a group that was erased: one of the keys over
 * it (`subjectsOver`) an add named as a group (`known_groups`) and an
 * erasure closed. Such a key is refused as an erased key is, named in its
 * group or not, so the promise holds whatever a producer passes.
 */
export const isUnderErasedGroup = (
  sql: SqlStorage,
  over: readonly string[]
): boolean =>
  over.length > 0 &&
  sql
    .exec(
      `SELECT 1 FROM known_groups
      JOIN erasures ON erasures.kind = 'source'
        AND erasures.subject = known_groups.subject
      WHERE known_groups.subject IN (SELECT value FROM json_each(?))
      LIMIT 1`,
      JSON.stringify(over)
    )
    .toArray().length > 0;

/** Whether `subject` names a key kept as a group's (`known_groups`). */
const isKnownGroup = (sql: SqlStorage, subject: string): boolean =>
  sql
    .exec("SELECT 1 FROM known_groups WHERE subject = ? LIMIT 1", subject)
    .toArray().length > 0;

/**
 * A source entry's body (its ledger object's text): `{"group":true}` when
 * the key was erased as a group's (`groupBody`), empty otherwise. Older
 * entries are all empty, and an older release never reads a source
 * entry's body: it applies a group's entry as its key's alone.
 */
const groupBody = JSON.stringify({ group: true });

/** Whether a source entry's body (`groupBody`) marks a group's erasure. */
const isGroupBody = (body: string): boolean => {
  if (body === "") {
    return false;
  }
  const parsed: unknown = JSON.parse(body);
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    "group" in parsed &&
    parsed.group === true
  );
};

/** Keeps `subject` as a group's, as an add names it, in the add's transaction. */
export const keepGroup = (sql: SqlStorage, subject: string): void => {
  sql.exec("INSERT OR IGNORE INTO known_groups (subject) VALUES (?)", subject);
};

/**
 * Keeps `source`'s subject, and its group's (`group`, null for none), as
 * its first version is recorded, in the caller's transaction.
 */
export const keepSubject = (
  sql: SqlStorage,
  source: string,
  subject: string,
  group: string | null = null
): void => {
  sql.exec(
    `INSERT OR IGNORE INTO source_subjects (source, subject, group_subject)
    VALUES (?, ?, ?)`,
    source,
    subject,
    group
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
 * is among them, the source no longer current and its queued work gone:
 * the items keyed by the source, and its re-checks, keyed by its SHA-256
 * and a set of readers (recheck.ts `dropRechecksOf`). Answers the keys of
 * the work it took, for what is under way on them to stop; none when the
 * current version was not among them.
 */
const hideVersions = (
  sql: SqlStorage,
  source: string,
  rows: readonly number[],
  key: string
): string[] => {
  const listed = JSON.stringify(rows);
  sql.exec(
    `INSERT OR IGNORE INTO erasing_versions (version_row, erasure)
    SELECT value, ? FROM json_each(?)`,
    key,
    listed
  );
  // Their vector codes leave the scan now, as a replaced version's do:
  // a code the scan may pick must be of a current version, or hidden ones
  // nearer the question would take every candidate and leave a reader's
  // live passages unfound until the deletion. Packed ones are marked
  // removed; `eraseVersion` repacks their blocks.
  for (const row of rows) {
    removeVectorsOf(sql, row);
  }
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
  if (!current) {
    return [];
  }
  sql.exec("DELETE FROM current_versions WHERE source = ?", source);
  // Work about a source is keyed by the source's key (work.ts `NewWork`),
  // but its re-checks, keyed by its SHA-256 and a set of readers.
  sql.exec("DELETE FROM work_items WHERE key = ?", source);
  return [source, ...dropRechecksOf(sql, source)];
};

/** The rows of `source`'s versions. */
const rowsOf = (sql: SqlStorage, source: string): number[] =>
  sql
    .exec<{ row: number }>(
      "SELECT row FROM source_versions WHERE source = ?",
      source
    )
    .toArray()
    .map(({ row }) => row);

/**
 * The sources an erasure of the key whose subject is `subject` covers:
 * the source of that key, and each added in it as a group. `apply` hides
 * each in turn, in its one transaction: a group's erasure costs time
 * linear in its sources (about 370 ms per 1,000 one-version sources in
 * workerd), and its deleting is the tick's, a bounded batch at a time.
 */
const sourcesOf = (sql: SqlStorage, subject: string): string[] =>
  sql
    .exec<{ source: string }>(
      "SELECT source FROM source_subjects WHERE subject = ?1 OR group_subject = ?1",
      subject
    )
    .toArray()
    .map(({ source }) => source);

/**
 * Deletes the set of readers `readerSet` once nothing points at it: the
 * principals it names go with the last row naming it.
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
            AND vector_blocks.reader_set = ?1)
        OR EXISTS (SELECT 1 FROM memories
          WHERE readers = (SELECT key FROM reader_sets WHERE id = ?1))
        OR EXISTS (SELECT 1 FROM memory_extractions
          WHERE readers = (SELECT key FROM reader_sets WHERE id = ?1)) AS used`,
      readerSet
    )
    .toArray();
  if (used?.used === 1) {
    return;
  }
  sql.exec("DELETE FROM reader_set_members WHERE reader_set = ?", readerSet);
  sql.exec("DELETE FROM reader_sets WHERE id = ?", readerSet);
};

/**
 * Applies the erasure `key` (`entry`): the store's record of it, and
 * everything it covers hidden. Run it in one transaction. Safe to repeat.
 * Answers the sources whose current version it hid, whose work under way
 * is to stop, and how many sources it found a version of to hide, which
 * the record keeps (`erasures.sources`).
 */
const apply = (
  sql: SqlStorage,
  key: string,
  entry: LedgerEntry,
  confirmed: boolean
): { stopped: string[]; sources: number } => {
  sql.exec(
    `INSERT OR IGNORE INTO erasures
      (key, kind, subject, reason, erased_at, confirmed)
    VALUES (?, 'source', ?, ?, ?, ?)`,
    key,
    entry.subject,
    entry.reason,
    entry.at,
    confirmed ? 1 : 0
  );
  const stopped: string[] = [];
  let sources = 0;
  for (const source of sourcesOf(sql, entry.subject)) {
    const rows = rowsOf(sql, source);
    sources += rows.length > 0 ? 1 : 0;
    stopped.push(...hideVersions(sql, source, rows, key));
  }
  // The first count of `key` stands: applied again (a replay), the
  // erasure answers what it erased then.
  sql.exec(
    "UPDATE erasures SET sources = ? WHERE key = ? AND sources IS NULL",
    sources,
    key
  );
  return { stopped, sources };
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
  const hashes = JSON.stringify(
    sql
      .exec<{ hash: string }>(
        "SELECT hash FROM chunks WHERE version_row = ? AND hash IS NOT NULL",
        version.row
      )
      .toArray()
      .map((chunk) => chunk.hash)
  );
  // Its words and stems go with each chunk (migration 0006's triggers).
  sql.exec("DELETE FROM chunks WHERE version_row = ?", version.row);
  // Its full vectors, in every build, go with the sweep once no current
  // chunk holds their text; what its model couldn't embed is forgotten.
  releaseVectors(sql, hashes);
  sql.exec(
    "DELETE FROM source_changes WHERE source = ? AND version_row = ?",
    version.source,
    version.row
  );
  // The memories drawn from it, with names no other memory gives
  // (forget.ts); hidden since the erasure, as their version is.
  const memorySets = eraseMemoriesOn(sql, version.row);
  sql.exec("DELETE FROM current_versions WHERE version_row = ?", version.row);
  sql.exec("DELETE FROM erasing_versions WHERE version_row = ?", version.row);
  sql.exec("DELETE FROM source_versions WHERE row = ?", version.row);
  // The source's key in plain, once no version holds it: it may name a
  // person (an instruction file's), and the erasure's own record keeps
  // only its hash.
  sql.exec(
    `DELETE FROM source_subjects WHERE source = ?1
    AND NOT EXISTS (SELECT 1 FROM source_versions WHERE source = ?1)`,
    version.source
  );
  // The sweep deletes the file once no version holds it (files.ts).
  sql.exec("UPDATE files SET refs = refs - 1 WHERE hash = ?", version.file);
  for (const readerSet of new Set([version.reader_set, ...memorySets])) {
    dropUnusedReaderSet(sql, readerSet);
  }
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

/**
 * A source's ledger entry recorded but not yet written (`confirmPending`).
 * A source's alone: a person's row the shared store recorded until
 * GRA-1903 is never written, nor waited for.
 */
const unconfirmed = "confirmed = 0 AND kind = 'source'";

/**
 * Whether the tick has an erasure's work to do: versions an erasure hid
 * still to delete (`eraseBatch`), or a ledger entry still to write
 * (`confirmPending`).
 */
export const erasureDue = (sql: SqlStorage): boolean =>
  sql
    .exec(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM erasing_versions)
        OR EXISTS (SELECT 1 FROM erasures WHERE ${unconfirmed})`
    )
    .toArray().length > 0;
/**
 * Whether the source whose key's subject is `subject` was erased, as
 * this store's record of the ledger holds it (contract.ts
 * `ErasureStatus`), in one statement: `erased` once every erasure of it
 * is confirmed in the ledger and none still hides versions this store's
 * tick has to delete, with when the latest was recorded; `erasing` until
 * then; `not_erased` when the record holds none. It reads the record
 * alone, never what is kept, so what was never erased answers as what
 * never existed. Not counted here: an erased version's file, which the
 * sweep deletes past its 15-minute grace once no version holds it
 * (files.ts), and anything another store (a person's own) still has to
 * delete of what it hid.
 */
export const erasureStatusOf = (
  sql: SqlStorage,
  subject: string
): Exclude<ErasureStatus, { state: "unavailable" }> => {
  const { erasures, unfinished, at } = sql
    .exec<{ erasures: number; unfinished: number; at: number | null }>(
      `SELECT count(*) AS erasures,
        coalesce(sum(
          confirmed = 0 OR EXISTS (
            SELECT 1 FROM erasing_versions WHERE erasure = erasures.key
          )
        ), 0) AS unfinished,
        max(erased_at) AS at
      FROM erasures WHERE kind = 'source' AND subject = ?`,
      subject
    )
    .one();
  if (erasures === 0 || at === null) {
    return { state: "not_erased" };
  }
  return unfinished > 0
    ? { state: "erasing" }
    : { state: "erased", at: new Date(at) };
};

/** How many erasures still hide versions the tick has to delete. */
export const erasuresUnfinished = (sql: SqlStorage): number =>
  sql
    .exec<{ count: number }>(
      "SELECT count(DISTINCT erasure) AS count FROM erasing_versions"
    )
    .one().count;

/**
 * How many sources keep versions no erasure hid but have no current
 * version, so no one can read them (`hideVersions`): a count, never which.
 */
export const sourcesWithoutCurrent = (sql: SqlStorage): number =>
  sql
    .exec<{ count: number }>(
      `SELECT count(DISTINCT source) AS count FROM source_versions
      WHERE source NOT IN (SELECT source FROM current_versions)
        AND row NOT IN (SELECT version_row FROM erasing_versions)`
    )
    .one().count;

/**
 * The erasures of sources the store applied, as its record of the ledger
 * keeps them: counts only, written to the ledger or not yet, and by
 * reason; never which, when, or the SHA-256 the ledger names one by. One
 * pass over the record, a row an erasure.
 */
export const erasuresOverview = (sql: SqlStorage): ErasuresOverview => {
  const overview: ErasuresOverview = {
    source: { written: 0, unwritten: 0 },
    byReason: { deleted: 0, retention: 0, person_erased: 0, withdrawn: 0 },
  };
  const counts = sql.exec<{
    reason: string;
    confirmed: number;
    count: number;
  }>(
    `SELECT reason, confirmed, count(*) AS count FROM erasures
    WHERE kind = 'source' GROUP BY reason, confirmed`
  );
  for (const { reason, confirmed, count } of counts) {
    if (confirmed === 1) {
      overview.source.written += count;
    } else {
      overview.source.unwritten += count;
    }
    if (isReason(reason)) {
      overview.byReason[reason] += count;
    }
  }
  return overview;
};

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
}

/**
 * Writes `recorded`'s ledger entry within `ledgerWaitMs`, and confirms
 * it: throws if R2 fails. Written again, it is the same.
 */
const confirm = async (
  { storage, bucket, groups }: ErasureStore,
  { key }: Recorded
): Promise<void> => {
  const named = entryOf(key)?.subject;
  const body =
    groups && named !== undefined && isKnownGroup(storage.sql, named)
      ? groupBody
      : "";
  await inTime(bucket.put(key, body));
  storage.sql.exec("UPDATE erasures SET confirmed = 1 WHERE key = ?", key);
};

/**
 * Writes the ledger entries of the erasures the store recorded but hasn't
 * confirmed, the oldest first, at most `confirmPerTick`: an erasure whose
 * write failed, or timed out and may have landed (written again, the
 * same). Throws once one fails, keeping the rest for the next tick.
 */
export const confirmPending = async (store: ErasureStore): Promise<void> => {
  // No write starts after `confirmTickMs`: the rest are the next tick's.
  const stopAt = Date.now() + confirmTickMs;
  const pending = store.storage.sql
    .exec<Recorded>(
      `SELECT key FROM erasures WHERE ${unconfirmed}
      ORDER BY key LIMIT ?`,
      confirmPerTick
    )
    .toArray();
  for (const recorded of pending) {
    if (Date.now() >= stopAt) {
      return;
    }
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
 * Erases the source whose key is `source`, for `reason` (above): recorded
 * and hidden, `stop` told at once of the sources whose current version it
 * hid (their work under way is to stop, whatever happens next), then the
 * ledger entry, then one batch deleted. Returns only once its entry is in
 * the ledger. Repeated after a failure, it is the same erasure, written
 * now; a source erased before answers at once. Answers how many sources
 * its erasure covered (`apply`), the same however often it is repeated:
 * what its latest record counted (none for one recorded before records
 * counted).
 */
export const erase = async (
  store: ErasureStore,
  source: string,
  reason: ErasureReason,
  stop: (sources: string[]) => void,
  { asGroup = false }: { asGroup?: boolean } = {}
): Promise<number> => {
  const { storage } = store;
  const { sql } = storage;
  const subject = await subjectOf(source);
  // Its erasure recorded before is the same erasure: its key was closed
  // then, so nothing was added to the source since. One not yet written
  // first, so a repeat after a failed write writes it.
  const before = sql
    .exec<Recorded & { confirmed: number }>(
      `SELECT key, confirmed FROM erasures
      WHERE kind = 'source' AND subject = ?
      ORDER BY confirmed, key LIMIT 1`,
      subject
    )
    .toArray()
    .at(0);
  // Erased before as its key alone, now said to be a group's: a second
  // entry records it as one (the ledger is never rewritten), marked
  // (`confirm`), so a replay keeps it a group's too.
  const markingGroup =
    before !== undefined &&
    asGroup &&
    store.groups &&
    !isKnownGroup(sql, subject);
  /** What the latest record of this source's erasure counted. */
  const counted = (): number =>
    sql
      .exec<{ sources: number | null }>(
        `SELECT sources FROM erasures WHERE kind = 'source' AND subject = ?
        ORDER BY key DESC LIMIT 1`,
        subject
      )
      .toArray()
      .at(0)?.sources ?? 0;
  if (before?.confirmed === 1 && !markingGroup) {
    return counted();
  }
  let recorded: Recorded | undefined = markingGroup ? undefined : before;
  if (recorded === undefined) {
    const hid = storage.transactionSync(() => {
      const at = nextAt(sql);
      const entry: LedgerEntry = { subject, reason, at };
      const key = ledgerKeyOf(entry);
      // Said to be a group's: kept as one, so its entry is marked
      // (`confirm`) and keys under it are refused from now on.
      if (asGroup && store.groups) {
        keepGroup(sql, subject);
      }
      return { key, stopped: apply(sql, key, entry, false).stopped };
    });
    recorded = { key: hid.key };
    stop(hid.stopped);
  }
  try {
    await confirm(store, recorded);
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
  return counted();
};

/**
 * Where a replay reads the ledger from: after the last entry this copy of
 * the store holds. That is part of the store, so it is exactly what this
 * copy has applied: on an ordinary start the listing finds nothing new;
 * after a restore the copy's mark is as old as the copy, and the listing
 * finds everything erased since. Keys only grow (`nextAt`), so every
 * entry a copy lacks sorts after all of its own.
 */
const replayStart = (sql: SqlStorage): string | undefined =>
  sql.exec<{ key: string | null }>("SELECT max(key) AS key FROM erasures").one()
    .key ?? undefined;

/** What one step of a replay did, and whether the ledger holds more. */
export interface Replayed {
  /** The sources whose current version it hid. */
  stopped: string[];
  /** Whether entries may be left to apply: the next step reads on. */
  more: boolean;
}

/**
 * The text of the ledger's object `key`, its read and its body within
 * `ledgerWaitMs`. One that is gone throws: only the store writes the
 * ledger, so it is a fault to fix, and the store serves nothing it may
 * have erased meanwhile.
 */
const textOf = async (bucket: BrainBucket, key: string): Promise<string> =>
  await inTime(
    (async () => {
      const object = await bucket.get(key);
      if (object === null) {
        throw new Error("An entry of the erasure ledger can't be read");
      }
      return await object.text();
    })()
  );

/**
 * Whether the entry `key` marks a group's erasure (`groupBody`), read
 * within `stopAt` (throws `OutOfTimeError` once it is past).
 */
const readGroupMark = async (
  bucket: BrainBucket,
  key: string,
  stopAt: number
): Promise<boolean> => {
  if (Date.now() >= stopAt) {
    throw new OutOfTimeError();
  }
  return isGroupBody(await textOf(bucket, key));
};

/**
 * One step of a replay: lists one page of the ledger after the store's
 * mark and applies, in order, the entries in it the store lacks (above),
 * each in its own transaction and recorded as confirmed. An entry takes
 * no read in the shared store, and one in a person's own (its body:
 * whether it was a group's). It stops after `replayReadsPerStep` reads,
 * or once `replayStepMs` is past, starting no new read; an entry it
 * didn't read is read by the next step, which goes on after the last
 * entry applied. Run it while the store
 * takes nothing else. Throws when R2 fails or doesn't answer in time,
 * keeping what it applied.
 *
 * Measured in local workerd on a laptop, a backlog of 3,000 erased
 * sources' entries after a restore: three steps of one list call each
 * (as the store started, then a step each for two ticks), 78 ms in all.
 * Not measured on Cloudflare.
 */
export const replayStep = async ({
  storage,
  bucket,
  groups,
}: ErasureStore): Promise<Replayed> => {
  const { sql } = storage;
  const stopAt = Date.now() + replayStepMs;
  const stopped: string[] = [];
  let reads = 0;
  // Where the listing goes on, in memory only: past a page that held no
  // entry to apply (a person's entries, `personEntryPattern`), never past
  // an entry not applied, so the store's mark moves with what it applied.
  let startAfter = replayStart(sql);
  for (;;) {
    if (Date.now() >= stopAt) {
      return { stopped, more: true };
    }
    // oxlint-disable-next-line no-await-in-loop -- a page after a page with nothing to apply
    const page = await inTime(
      bucket.list({ prefix: ledgerPrefix, startAfter, limit: ledgerPageSize })
    );
    let applied = 0;
    for (const { key } of page.objects) {
      const entry = entryOf(key);
      if (entry === undefined && !personEntryPattern.test(key)) {
        // A key this release can't read (a later release's, kept through a
        // rollback): never passed, so nothing after it is skipped.
        throw new Error("A key of the erasure ledger can't be read");
      }
      const isNew =
        entry !== undefined &&
        sql.exec("SELECT 1 FROM erasures WHERE key = ?", key).toArray()
          .length === 0;
      if (isNew) {
        if (Date.now() >= stopAt || (groups && reads >= replayReadsPerStep)) {
          return { stopped, more: true };
        }
        let group = false;
        if (groups) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- in order, one entry at a time
            group = await readGroupMark(bucket, key, stopAt);
          } catch (error) {
            if (error instanceof OutOfTimeError) {
              return { stopped, more: true };
            }
            throw error;
          }
          reads += 1;
        }
        for (const source of storage.transactionSync(() => {
          // Kept as a group's before it applies: keys under it refused,
          // though the copy restored predates the group's first add.
          if (group) {
            keepGroup(sql, entry.subject);
          }
          return apply(sql, key, entry, true).stopped;
        })) {
          stopped.push(source);
        }
        applied += 1;
      }
    }
    const last = page.objects.at(-1)?.key;
    if (applied > 0 || !page.truncated || last === undefined) {
      return { stopped, more: page.truncated };
    }
    startAfter = last;
  }
};

// A person's own store, erased whole (store.ts): when the person is
// erased, their store is deleted, not searched for what is theirs, since
// all of it is. The record of it is one object in the store's own part of
// the bucket, `erased`, outside the ledger's listing and never deleted:
// written before anything is deleted, so a store that comes back (a
// restore of its storage, or a late add waking it afresh) finds it before
// it answers anything, deletes all it holds again and refuses every call.
// Its files, its vectors and its own ledger's entries (when each of its
// sources was erased, by a hash of its key) are then deleted under their
// prefixes, a bounded batch a call, until none is left: the record is all
// that stays of it.

/** The key of the record that a person's store was erased whole. */
export const storeErasedKey = "erased";

/** Most objects one call lists and deletes, per prefix: one page of R2's listing. */
const storeDeletePage = 1000;

/** How long one call starts new listings and deletes for. */
const storeDeleteMs = 10_000;

/** Whether the store whose part of the bucket is `bucket` was erased whole. */
export const isStoreErased = async (bucket: BrainBucket): Promise<boolean> =>
  (await inTime(bucket.head(storeErasedKey))) !== null;

/** The record of a store's erasure, as `recordStoreErased` writes it. */
const storeErasedSchema = z.object({ at: z.number() });

/**
 * When the store whose part of the bucket is `bucket` was erased whole, in
 * milliseconds, by its record: null when there is none. Throws when R2
 * fails or doesn't answer in time, or the record can't be read.
 */
export const storeErasedAt = async (
  bucket: BrainBucket
): Promise<number | null> => {
  const record = await inTime(bucket.get(storeErasedKey));
  if (record === null) {
    return null;
  }
  const text = await inTime(record.text());
  return storeErasedSchema.parse(JSON.parse(text)).at;
};

/**
 * Reads the first page of the ledger of the store whose part of the bucket
 * is `bucket`, before a person's own store makes its schema, so a store
 * whose ledger can't be read makes nothing: throws when R2 fails or
 * doesn't answer in time.
 */
export const readLedgerStart = async (bucket: BrainBucket): Promise<void> => {
  await inTime(bucket.list({ prefix: ledgerPrefix, limit: 1 }));
};

/**
 * Records that the store whose part of the bucket is `bucket` is erased
 * whole, and why: throws when R2 fails or doesn't answer in time, and
 * then nothing is deleted. Written again, it says the same.
 */
export const recordStoreErased = async (
  bucket: BrainBucket,
  reason: ErasureReason,
  at: number
): Promise<void> => {
  await inTime(bucket.put(storeErasedKey, JSON.stringify({ reason, at })));
};

/**
 * Deletes a page of the objects under `prefixes` in `bucket`,
 * for at most `storeDeleteMs`: true once none is left. Throws when R2
 * fails or doesn't answer in time; what it deleted stays deleted.
 */
export const deleteStoreObjects = async (
  bucket: BrainBucket,
  prefixes: readonly string[]
): Promise<boolean> => {
  const stopAt = Date.now() + storeDeleteMs;
  for (const prefix of prefixes) {
    for (;;) {
      if (Date.now() >= stopAt) {
        return false;
      }
      // oxlint-disable-next-line no-await-in-loop -- a page after a page
      const page = await inTime(
        bucket.list({ prefix, limit: storeDeletePage })
      );
      if (page.objects.length === 0) {
        break;
      }
      // oxlint-disable-next-line no-await-in-loop -- a page after a page
      await inTime(bucket.delete(page.objects.map(({ key }) => key)));
    }
  }
  return true;
};

/**
 * Replays on memories what the erasures of sources the store recorded
 * since it last did covered, as the store starts, in one transaction:
 * every memory drawn from each. So an erasure an older release recorded,
 * which knew no memories (an admin's rollback), reaches them after the
 * roll forward; one this release applied finds nothing more. Only those above the mark (`memory_erasure_replay`) are read, and
 * the mark moves past them, so a start with none recorded since reads one
 * row. (The mark orders by `erasures`' rowid: a column of its own would
 * be null on every row an older release writes.) Answers how many it
 * replayed.
 */
export const replayMemoryErasures = (sql: SqlStorage): number => {
  const through =
    sql
      .exec<{ through: number }>(
        "SELECT through FROM memory_erasure_replay WHERE id = 1"
      )
      .toArray()
      .at(0)?.through ?? 0;
  // The mark moves past every row recorded since, a source's or not: a
  // person's, which the shared store recorded until GRA-1903, covers
  // nothing here.
  const last = sql
    .exec<{ rowid: number | null }>(
      "SELECT max(rowid) AS rowid FROM erasures WHERE rowid > ?",
      through
    )
    .one().rowid;
  if (last === null) {
    return 0;
  }
  const recorded = sql
    .exec<{ subject: string }>(
      `SELECT subject FROM erasures
      WHERE rowid > ? AND kind = 'source' ORDER BY rowid`,
      through
    )
    .toArray();
  const sets: number[] = [];
  for (const { subject } of recorded) {
    // The source's, and those of each source added in it as a group.
    for (const { source } of sql
      .exec<{ source: string }>(
        `SELECT ?1 AS source UNION
        SELECT subject AS source FROM source_subjects WHERE group_subject = ?1`,
        subject
      )
      .toArray()) {
      sets.push(...eraseMemoriesOfSource(sql, source));
    }
  }
  for (const readerSet of new Set(sets)) {
    dropUnusedReaderSet(sql, readerSet);
  }
  sql.exec(
    `INSERT INTO memory_erasure_replay (id, through) VALUES (1, ?1)
    ON CONFLICT (id) DO UPDATE SET through = ?1`,
    last
  );
  return recorded.length;
};
