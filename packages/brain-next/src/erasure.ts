import { erasureReasons } from "./contract.ts";
import type { ErasureReason, ErasuresOverview } from "./contract.ts";
import { hashOf, releaseVectors } from "./files.ts";
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
// names exactly what it hid, the versions by number under each source's
// SHA-256, in parts of at most `ledgerPartVersions` (objects of their own
// under the entry's key, `<key>/0000` on), written before the entry
// itself, whose body says how many parts there are: an entry in the
// bucket is whole. No content, no plain id. Entries are never deleted: a
// copy of the store of any age can come back.
//
// The order, so a crash serves nothing erased, and an erasure that
// returned is never lost:
//
// 1. In one transaction: the erasure recorded in the store, unconfirmed,
//    and everything it covers hidden: listed in `erasing_versions`, which
//    history leaves out, their change keys gone, and, where a source's
//    current version is among them, its current pointer and queued work.
//    A person's erasure works out what it covers here, in the same
//    transaction, so nothing added meanwhile slips between.
// 2. The ledger entry is written, its parts first, and the erasure
//    confirmed: only then does the erasure return. If R2 fails or doesn't
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
// applies what it lacks, literally: a source's entry hides every version
// of that source and closes its key; a person's hides the versions it
// names, nothing worked out again from the older copy's readers. It does
// so a bounded step at a time (`replayStep`), each entry in its own
// transaction, so a long replay goes on where the last step stopped. Until
// it is through, and while it can't read the ledger, the store answers
// nothing but its overview (store.ts).
//
// An erased source's key stays closed: an add to it is refused, checked
// again in the transaction that would record it (sources.ts). So is an
// add for a person alone that began before that person's erasure and
// lands after it. What is added for them after the erasure is new and
// kept.
//
// Nothing an erasure answers depends on what it found: it is recorded
// and answers alike for a source or person that held nothing.
//
// What an erasure deletes never frees a name for what comes after it: a
// source's next version is numbered past every one erased (sources.ts),
// and a queued item's id is never used twice (migration 0006), so a late
// vector put, a citation or a handler settling under an old name never
// reaches new content. Reads that wait for a file ask again, after it,
// whether the version may still be read (sources.ts). And no plain key or
// id outlives what it named: a source's key leaves `source_subjects` with
// its last version, and an erased person's set of readers goes with theirs.

/** The parts of the store an erasure works with. */
export interface ErasureStore {
  readonly storage: DurableObjectStorage;
  readonly bucket: R2Bucket;
}

/** What is erased: a source, or what a person alone may read. */
type ErasureKind = "source" | "person";

/** What a person's erasure hid: each version by number, under its source's subject. */
type Hidden = (readonly [subject: string, version: number])[];

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

/**
 * How long a tick starts writing unconfirmed entries for: a slow bucket
 * delays the tick's queue by this and one write's 10 s at most.
 */
const confirmTickMs = 30_000;

/**
 * Most versions one part of a person's entry names: about 75 bytes each,
 * so a part is at most some 75 KB, far inside any limit of R2 or of a
 * value the store keeps, however many versions an erasure hides.
 */
export const ledgerPartVersions = 1000;

/**
 * Most objects of the ledger one step of a replay reads (`replayStep`): a
 * person's entry and each of its parts; a source's entry is read from its
 * key alone, no read. Entries are read one at a time, an entry's parts six
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

/** Most reads of the ledger in flight at once, in all of a step. */
const readsAtOnce = 6;

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

/**
 * Whether `key` is a part of an entry: the entry's key, "/" and digits.
 */
const isPartKey = (key: string): boolean => {
  const slash = key.lastIndexOf("/");
  return (
    /^\d+$/u.test(key.slice(slash + 1)) &&
    entryOf(key.slice(0, slash)) !== undefined
  );
};

const subjectPattern = /^[0-9a-f]{64}$/u;

/** A part of a person's entry, as the ledger holds it. */
const partOf = (body: string): Hidden => {
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed)) {
    throw new TypeError("Not a part of an erasure");
  }
  return parsed.map((pair: unknown) => {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      !subjectPattern.test(pair[0]) ||
      !Number.isSafeInteger(pair[1])
    ) {
      throw new TypeError("Not a part of an erasure");
    }
    return [pair[0], Number(pair[1])] as const;
  });
};

/** How many parts a person's entry's body says it has. */
const partsOf = (body: string): number => {
  const parsed: unknown = JSON.parse(body);
  const parts: unknown =
    typeof parsed === "object" && parsed !== null
      ? Reflect.get(parsed, "parts")
      : undefined;
  if (typeof parts !== "number" || !Number.isSafeInteger(parts) || parts < 0) {
    throw new TypeError("Not an erasure");
  }
  return parts;
};

/** The key of part `index` of the entry `key`. */
const partKeyOf = (key: string, index: number): string =>
  `${key}/${String(index).padStart(4, "0")}`;

/** `items` in slices of at most `size`. */
const slicesOf = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size)
  );

/** Thrown when a step of a replay is out of time: no new read starts. */
class OutOfTimeError extends Error {
  constructor() {
    super("A step of the replay is out of time");
    this.name = "OutOfTimeError";
  }
}

/**
 * `run` over `items`, `readsAtOnce` at a time, in order, starting none
 * once `stopAt` is past (throws `OutOfTimeError`).
 */
const fewAtATime = async <T, R>(
  items: readonly T[],
  stopAt: number,
  run: (item: T) => Promise<R>
): Promise<R[]> => {
  const done: R[] = [];
  for (const slice of slicesOf(items, readsAtOnce)) {
    if (Date.now() >= stopAt) {
      throw new OutOfTimeError();
    }
    // oxlint-disable-next-line no-await-in-loop -- a few at a time
    for (const result of await Promise.all(slice.map(run))) {
      done.push(result);
    }
  }
  return done;
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
 * The highest version of the source whose key's subject is `subject` that
 * an erasure of a person deleted: an add numbers the next one past it
 * (sources.ts), so a version's number is never used twice. A source's own
 * erasure closes its key, so none of its versions is added again.
 */
export const lastErasedVersion = (sql: SqlStorage, subject: string): number =>
  sql
    .exec<{ version: number | null }>(
      "SELECT max(version) AS version FROM erased_versions WHERE subject = ?",
      subject
    )
    .one().version ?? 0;

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
 *
 * The versions it leaves are kept as they are, and no other becomes
 * current: history never becomes recall. So a replay after a restore,
 * where the older copy's current version was the erased person's own and
 * a team's version came before it, leaves that team version stored with
 * no current version, which no one can read; the overview counts such
 * sources (`sourcesWithoutCurrent`), so they are never out of sight.
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
 * What a person's erasure covers, as it will hide it: every version only
 * `person` may read, and every version of each source whose current
 * version is such. Run in the transaction that records the erasure, so
 * nothing recorded before it escapes and nothing recorded after it is in.
 */
const coveredFor = (sql: SqlStorage, person: string): Hidden =>
  sql
    .exec<{ subject: string; version: number }>(
      `WITH theirs AS (
        SELECT id FROM reader_sets WHERE key = ?1
      ),
      whole AS (
        SELECT source_versions.source AS source FROM source_versions
        JOIN current_versions ON current_versions.version_row = source_versions.row
        WHERE source_versions.reader_set IN (SELECT id FROM theirs)
      )
      SELECT source_subjects.subject AS subject, source_versions.version AS version
      FROM source_versions
      JOIN source_subjects ON source_subjects.source = source_versions.source
      WHERE source_versions.source IN (SELECT source FROM whole)
        OR source_versions.reader_set IN (SELECT id FROM theirs)
      ORDER BY subject, version`,
      readerSetKeyOf({ kind: "owner", person })
    )
    .toArray()
    .map(({ subject, version }) => [subject, version] as const);

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
      (key, kind, subject, reason, erased_at, confirmed)
    VALUES (?, ?, ?, ?, ?, ?)`,
    key,
    entry.kind,
    entry.subject,
    entry.reason,
    entry.at,
    confirmed ? 1 : 0
  );
  // What it hid, kept a row a version, a slice a statement, so no value
  // grows with how much it hid.
  for (const slice of slicesOf(hidden ?? [], ledgerPartVersions)) {
    sql.exec(
      `INSERT OR IGNORE INTO erased_versions (erasure, subject, version)
      SELECT ?, value ->> 0, value ->> 1 FROM json_each(?)`,
      key,
      JSON.stringify(slice)
    );
  }
  const bySubject = new Map<string, number[] | undefined>();
  if (hidden === null) {
    bySubject.set(entry.subject, undefined);
  } else {
    for (const [subject, version] of hidden) {
      const versions = bySubject.get(subject);
      if (versions === undefined) {
        bySubject.set(subject, [version]);
      } else {
        versions.push(version);
      }
    }
  }
  const stopped: string[] = [];
  for (const [subject, versions] of bySubject) {
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
 * The erasures the store applied, as its record of the ledger keeps them:
 * counts only, by kind, written to the ledger or not yet, and by reason;
 * never which, when, or the SHA-256 the ledger names one by. One pass
 * over the record, a row an erasure.
 */
export const erasuresOverview = (sql: SqlStorage): ErasuresOverview => {
  const overview: ErasuresOverview = {
    source: { written: 0, unwritten: 0 },
    person: { written: 0, unwritten: 0 },
    byReason: { deleted: 0, retention: 0, person_erased: 0, withdrawn: 0 },
  };
  const counts = sql.exec<{
    kind: string;
    reason: string;
    confirmed: number;
    count: number;
  }>(
    `SELECT kind, reason, confirmed, count(*) AS count FROM erasures
    GROUP BY kind, reason, confirmed`
  );
  for (const { kind, reason, confirmed, count } of counts) {
    const of = kind === "person" ? overview.person : overview.source;
    if (confirmed === 1) {
      of.written += count;
    } else {
      of.unwritten += count;
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
  kind: string;
}

/**
 * Writes `recorded`'s ledger entry, a person's parts first and then the
 * entry, each write within `ledgerWaitMs`, and confirms it: throws if R2
 * fails. Written again, it is the same.
 */
const confirm = async (
  { storage, bucket }: ErasureStore,
  { key, kind }: Recorded
): Promise<void> => {
  let body = "";
  if (kind === "person") {
    const hidden = storage.sql
      .exec<{ subject: string; version: number }>(
        `SELECT subject, version FROM erased_versions WHERE erasure = ?
        ORDER BY subject, version`,
        key
      )
      .toArray()
      .map(({ subject, version }) => [subject, version] as const);
    const parts = slicesOf(hidden, ledgerPartVersions);
    for (const [index, part] of parts.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- in order, each in its time
      await inTime(bucket.put(partKeyOf(key, index), JSON.stringify(part)));
    }
    body = JSON.stringify({ parts: parts.length });
  }
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
      `SELECT key, kind FROM erasures WHERE confirmed = 0
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
 * Erases `id`, a source's key or a person's id, for `reason` (above):
 * recorded and hidden, `stop` told at once of the sources whose current
 * version it hid (their work under way is to stop, whatever happens
 * next), then the ledger entry, then one batch deleted. Returns only once
 * its entry is in the ledger. Repeated after a failure: a source's is the
 * same erasure, written now; for a person, each erasure of them recorded
 * and not yet written is written first, from what it recorded
 * (`erased_versions`), however much the tick deleted meanwhile, and then
 * the call erases as a first one does, as of now. A source erased before
 * answers at once.
 */
export const erase = async (
  store: ErasureStore,
  kind: ErasureKind,
  id: string,
  reason: ErasureReason,
  stop: (sources: string[]) => void
): Promise<void> => {
  const { storage } = store;
  const { sql } = storage;
  const subject = await subjectOf(id);
  // A source's erasure recorded before is the same erasure: its key was
  // closed then, so nothing was added to the source since.
  const before =
    kind === "source"
      ? sql
          .exec<Recorded & { confirmed: number }>(
            `SELECT key, kind, confirmed FROM erasures
            WHERE kind = 'source' AND subject = ? LIMIT 1`,
            subject
          )
          .toArray()
          .at(0)
      : undefined;
  if (before?.confirmed === 1) {
    return;
  }
  // A person's erasures recorded and not yet written (a call that failed)
  // are written first, from what they recorded, so none is left behind a
  // call that answers; then this call records its own, as of now, so it
  // covers what was added for them since, whatever the tick did meanwhile.
  try {
    for (const pending of kind === "person"
      ? sql
          .exec<Recorded>(
            `SELECT key, kind FROM erasures
            WHERE kind = 'person' AND subject = ? AND confirmed = 0
            ORDER BY key`,
            subject
          )
          .toArray()
      : []) {
      // oxlint-disable-next-line no-await-in-loop -- in order, oldest first
      await confirm(store, pending);
    }
  } catch {
    throw new Error(notRecorded);
  }
  let recorded: Recorded | undefined = before;
  if (recorded === undefined) {
    const hid = storage.transactionSync(() => {
      const at = nextAt(sql);
      const entry: LedgerEntry = { kind, subject, reason, at };
      const key = ledgerKeyOf(entry);
      const hidden = kind === "person" ? coveredFor(sql, id) : null;
      return { key, stopped: apply(sql, key, entry, hidden, false) };
    });
    recorded = { key: hid.key, kind };
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
};

/**
 * Where a replay reads the ledger from: after the last entry this copy of
 * the store holds, and after that entry's parts. That is part of the
 * store, so it is exactly what this copy has applied: on an ordinary start
 * the listing finds nothing new; after a restore the copy's mark is as old
 * as the copy, and the listing finds everything erased since. Keys only
 * grow (`nextAt`), so every entry a copy lacks sorts after all of its own.
 */
const replayStart = (sql: SqlStorage): string | undefined => {
  const last = sql
    .exec<{ key: string | null }>("SELECT max(key) AS key FROM erasures")
    .one().key;
  // A part's key is the entry's, "/" and digits: "~" sorts after them all.
  return last === null ? undefined : `${last}/~`;
};

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
const textOf = async (bucket: R2Bucket, key: string): Promise<string> =>
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
 * What a person's entry `key` hid: its body, then its parts by their
 * computed keys (so where a page of the listing ends among them doesn't
 * matter), a few at a time, none started once `stopAt` is past. An entry
 * is read whole, however many parts it has, past the step's read budget:
 * it is as big as the erasure's own transaction was. A known limit: at
 * about 1 s a read, an entry of more than roughly 90 parts can't be read
 * within one step, and the store stays `replaying` until the bucket is
 * faster; the overview shows it, and it is never unsafe. Answers it with
 * the reads it took.
 */
const readPerson = async (
  bucket: R2Bucket,
  key: string,
  stopAt: number
): Promise<{ hidden: Hidden; reads: number }> => {
  if (Date.now() >= stopAt) {
    throw new OutOfTimeError();
  }
  const parts = partsOf(await textOf(bucket, key));
  const read = await fewAtATime(
    Array.from({ length: parts }, (_, index) => partKeyOf(key, index)),
    stopAt,
    async (partKey) => partOf(await textOf(bucket, partKey))
  );
  return { hidden: read.flat(), reads: 1 + parts };
};

/**
 * One step of a replay: lists one page of the ledger after the store's
 * mark and applies, in order, the entries in it the store lacks,
 * literally (above), each in its own transaction and recorded as
 * confirmed. A source's entry takes no read; a person's is read with its
 * parts, at most `readsAtOnce` reads in flight. It stops after
 * `replayReadsPerStep` reads, or once `replayStepMs` is past, starting no
 * new read; an entry it didn't finish reading is read again by the next
 * step, which goes on after the last entry applied. Run it while the store
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
}: ErasureStore): Promise<Replayed> => {
  const { sql } = storage;
  const stopAt = Date.now() + replayStepMs;
  const stopped: string[] = [];
  let reads = 0;
  // Where the listing goes on, in memory only: past a page that held no
  // entry to apply (orphan parts of an entry never written), never past
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
      if (entry === undefined && !isPartKey(key)) {
        // A key this release can't read (a later release's, kept through a
        // rollback): never passed, so nothing after it is skipped.
        throw new Error("A key of the erasure ledger can't be read");
      }
      const isNew =
        entry !== undefined &&
        sql.exec("SELECT 1 FROM erasures WHERE key = ?", key).toArray()
          .length === 0;
      if (isNew) {
        if (
          Date.now() >= stopAt ||
          (entry.kind === "person" && reads >= replayReadsPerStep)
        ) {
          return { stopped, more: true };
        }
        let hidden: Hidden | null = null;
        if (entry.kind === "person") {
          try {
            // oxlint-disable-next-line no-await-in-loop -- in order, one entry at a time
            const read = await readPerson(bucket, key, stopAt);
            ({ hidden } = read);
            reads += read.reads;
          } catch (error) {
            if (error instanceof OutOfTimeError) {
              return { stopped, more: true };
            }
            throw error;
          }
        }
        for (const source of storage.transactionSync(() =>
          apply(sql, key, entry, hidden, true)
        )) {
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
