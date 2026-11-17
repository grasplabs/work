import { z } from "zod";

import type { BrainBucket } from "./bucket.ts";
import { erasureReasons, refusalPrefix } from "./contract.ts";
import type {
  ErasureReason,
  ErasureStatus,
  ErasuresOverview,
  Identifier,
} from "./contract.ts";
import { foldIdentifier } from "./entities.ts";
import { hashOf, releaseVectors } from "./files.ts";
import {
  deleteMemories,
  eraseMemoriesOfSource,
  eraseMemoriesOn,
} from "./forget.ts";
import {
  erasedBySql,
  lineageOfWriter,
  nextStamp,
  raiseStamp,
} from "./memories.ts";
import {
  applyPerson,
  foundForReplay,
  replayHashesPerStep,
  identifierSubjectOf,
  personSubjectOf,
} from "./people.ts";
import type { HeldIdentifier, PersonFound, ReplayMemo } from "./people.ts";
import { removeVectorsOf, repackBlocks } from "./vectors.ts";

// Erasure: what goes for good, apart from ordinary removal. A new version
// of a source ends the one before as history, readable as it was; an
// erasure leaves nothing. It covers one source (`eraseSource`: every
// version, and every version of each source added in its key as a group,
// as a chat's turns are in a person's own store), or what one writer wrote
// (`eraseWriter`: every memory of its lineage learned before the erasure),
// and reaches every place content is: versions, chunks, their words and stems, vector codes and
// the packed blocks they were in, change keys, queued work, and the files
// in R2, which the sweep deletes once no version holds them
// (files.ts: its grace and its in-doubt rule hold for them as for any).
//
// What only one person may read has no erasure here: the shared store
// refuses it as it is added (store.ts `#mayKeep`), and a person's own
// store, which holds only theirs, is erased whole (below).
//
// One ledger records every erasure: an object per erasure in the Brain's
// bucket (`erasures/`), whose key says when, the kind, the reason, and the
// SHA-256 of the source's key or of the writer's lineage (`writer:<id>`).
// No content, no plain id. Entries are never
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
// A writer's erasure (an App's memories when its data is reset or its
// store deleted) covers the memories of the writer's lineage learned
// before it, and nothing else: no source, and no memory of anyone else, on
// the same entity or not. Its record is the hide: every statement that
// reads, counts, links or exports a memory asks that no erasure of its
// writer came after it was learned (memories.ts `unerasedSql`), so one row
// hides them all at once, however many, also those an older copy of the
// store comes back with; then they are deleted a batch at a time
// (`eraseWriterBatch`), by the call and then the tick. Its time is a write
// stamp of the store's memories, and the store's stamp is raised to it
// wherever it is applied, so what the writer adds afterwards is learned
// after it and kept: the writer is never closed, as a source's key is. It
// is asked under the caller's change, whose SHA-256 its record and its
// entry's body keep with how many memories it covered: the same change is
// the same erasure, answered as recorded, also after a replay; another
// change is another erasure. An export holding a memory of the writer
// learned before it is stale (exports.ts `namedSql`), and a restore of an
// export writes none it covers, also once a restore is under way when the
// erasure lands (restore.ts `passesOverMemory`).
//
// A person's erasure in the shared store (`erasePersonShared`, people.ts)
// takes what the store derived about them and what is in their own word,
// and keeps the sources: recorded with what it hid in one transaction,
// which is the hide (memories.ts `unerasedSql`, by
// `person_erasure_memories`), then its ledger entry written, whose body
// holds the SHA-256 of what it closed, then a batch of what it hid
// deleted (`eraseWriterBatch`); the tick deletes the rest. A replay finds
// what the entry names in the copy by hashing what the copy holds.
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

/**
 * What is erased: a source, what a writer wrote, or what the shared store
 * derived about a person.
 */
type ErasureKind = "source" | "writer" | "person";

/** An erasure, as the ledger holds it. */
interface LedgerEntry {
  kind: ErasureKind;
  /** The SHA-256 of the source's key, of the writer's lineage, or of the person's id, in hex. */
  subject: string;
  reason: ErasureReason;
  /**
   * When, in milliseconds. A writer's erasure's is a write stamp of the
   * store's memories (memories.ts `stampWrite`): it covers those learned
   * before it, and every write after it is stamped later.
   */
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
 * Most entries of the ledger one step of a replay reads (`replayStep`):
 * in a person's own store, each source entry, for its mark of a group
 * (`groupBody`); in the shared store, which holds no group, each writer's
 * entry, for its change and count (`WriterBody`). One at a time. A first
 * guess, well inside the step's time.
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
const ledgerKeyOf = ({ at, kind, reason, subject }: LedgerEntry): string =>
  `${ledgerPrefix}${timeOf(at)}-${kind}-${reason}-${subject}`;

const ledgerKeyPattern =
  /^erasures\/(?<at>\d{15})-(?<kind>source|writer|person)-(?<reason>[a-z_]+)-(?<subject>[0-9a-f]{64})$/u;

/**
 * One of the parts (`<key>/0000` on) of a person's entry, as the shared
 * store wrote them until it refused what only one person may read
 * (GRA-1822): a replay passes over them. A whole key of that kind is a
 * person's erasure of the shared store now (`erasePersonShared`), which
 * `ledgerKeyPattern` reads first. Nothing released holds one, and
 * a store written since holds nothing such an entry hid; one restored
 * from before keeps what it hid (GRA-1903). Removed once staging's Brain
 * is reset (GRA-1907).
 */
const personEntryPattern =
  /^erasures\/\d{15}-person-[a-z_]+-[0-9a-f]{64}(?:\/\d+)?$/u;

const isReason = (reason: string): reason is ErasureReason =>
  erasureReasons.some((known) => known === reason);

const isKind = (kind: string): kind is ErasureKind =>
  kind === "source" || kind === "writer" || kind === "person";

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

/** Thrown when a step of a replay is out of time: no new read starts. */
class OutOfTimeError extends Error {
  constructor() {
    super("A step of the replay is out of time");
    this.name = "OutOfTimeError";
  }
}

/**
 * What a replay of person entries read and hashed so far, by the store's
 * storage, until it is through (people.ts `ReplayMemo`): a step out of
 * time leaves it to the next, so a long one goes on, never starts over.
 */
const replayMemos = new WeakMap<DurableObjectStorage, ReplayMemo>();

/**
 * A step's end: once the replay is through, what it kept goes. That only
 * lets the memory go, and nothing observes it: an instance replays only
 * until it is through, never again after.
 */
const stepEnded = (
  storage: DurableObjectStorage,
  stopped: string[],
  more: boolean
): Replayed => {
  if (!more) {
    replayMemos.delete(storage);
  }
  return { stopped, more };
};

const encoder = new TextEncoder();

/** The ledger's name for a source's key. */
export const subjectOf = async (id: string): Promise<string> =>
  await hashOf(encoder.encode(id));

/**
 * The ledger's name for a writer: the SHA-256 of its lineage
 * (`writer:<id>`), as each of its memories keeps it (`writer_subject`).
 */
export const writerSubjectOf = async (writer: string): Promise<string> =>
  await subjectOf(lineageOfWriter(writer));

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
  group: string | null = null,
  thread = false
): void => {
  sql.exec(
    `INSERT OR IGNORE INTO source_subjects (source, subject, group_subject, thread)
    VALUES (?, ?, ?, ?)`,
    source,
    subject,
    group,
    thread ? 1 : 0
  );
};

/**
 * Whether `source` is a thread (`NewSource.thread`), as its first version
 * said: undefined before it has one.
 */
export const isThread = (
  sql: SqlStorage,
  source: string
): boolean | undefined => {
  const found = sql
    .exec<{ thread: number }>(
      "SELECT thread FROM source_subjects WHERE source = ?",
      source
    )
    .toArray()
    .at(0);
  return found === undefined ? undefined : found.thread === 1;
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
  // A removed source stays removed, its key closed, but its mark no
  // longer names a version that is going (removal.ts).
  sql.exec(
    `UPDATE removed_sources SET version_row = NULL
    WHERE version_row IN (SELECT value FROM json_each(?))`,
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
  if (current) {
    sql.exec("DELETE FROM current_versions WHERE source = ?", source);
    // Work about a source is keyed by the source's key (work.ts `NewWork`).
    sql.exec("DELETE FROM work_items WHERE key = ?", source);
  }
  return current;
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
 * each in turn, in its one transaction, so no reader sees a group part
 * hidden, and a call cut off hides and records nothing: its caller keeps
 * the erasure owed and repeats it. Its deleting is the tick's, a bounded
 * batch at a time.
 *
 * So a group's erasure costs time linear in what it hides, each row found
 * by an index (erasure-cost.test.ts holds it): in local workerd on a
 * laptop, 3.0 s for a call erasing 50,000 one-chunk sources with an item
 * queued for each, its first delete batch included (GRA-1812). That
 * excludes vectors: hiding a version also reads its chunks' vector codes
 * (`removeVectorsOf`), so a source of many chunks with codes costs more.
 * A call has a Durable Object request's 30 s of CPU: some 500,000 such
 * sources. A replay applies the entry as the store starts, within the
 * 30 s the store may be held, but a step may start the entry's read just
 * before its own time is up (`replayStepMs`), and that read may take
 * `ledgerWaitMs`, leaving the apply about 10 s: some 200,000 sources.
 * Past that, the store is reset and the next start begins at that entry
 * with a fresh budget. Measured on a laptop, not on Cloudflare.
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
  // Its blocks hold none of its chunks now (chunk-blocks.ts).
  sql.exec("DELETE FROM chunk_blocks WHERE reader_set = ?", readerSet);
  sql.exec("DELETE FROM reader_sets WHERE id = ?", readerSet);
};

/**
 * What a writer's erasure's ledger entry holds besides its key: the
 * SHA-256 of the change it was asked under, and how many memories it
 * covered as it was first applied. So a replay records it as it was, and
 * the same change answers the same, also after a restore of an older copy.
 */
const writerBodySchema = z.strictObject({
  change: z.string().regex(/^[0-9a-f]{64}$/u),
  memories: z.int().nonnegative(),
});
type WriterBody = z.infer<typeof writerBodySchema>;

/**
 * The body of a person's entry (`erasePersonShared`): what it closed
 * (people.ts), their identifiers by SHA-256, never a plain value, and
 * their entities by the store's id. Or, as the shared store wrote a
 * person's entry until it refused what only one person may read
 * (GRA-1822: `{ parts }`, its parts under `<key>/0000` on, which
 * `personEntryPattern` passes over): nothing is applied for it but its
 * record. That legacy body and `personEntryPattern` go together, once
 * staging's Brain is reset (GRA-1907, #2311).
 */
const personBodySchema = z.union([
  z.strictObject({
    subjects: z.array(
      z.string().regex(/^(?:[0-9a-f]{64}|entity:[0-9a-f-]{36})$/u)
    ),
  }),
  z.strictObject({ parts: z.int().nonnegative() }),
]);
type PersonBody = z.infer<typeof personBodySchema>;

/**
 * Records the person's erasure `key` (`entry`) and applies it to what
 * `found` names (people.ts `applyPerson`), in the caller's transaction;
 * none found (a legacy entry's body): its record alone.
 */
const applyPersonEntry = (
  sql: SqlStorage,
  key: string,
  entry: LedgerEntry,
  confirmed: boolean,
  found: PersonFound | undefined
): void => {
  sql.exec(
    `INSERT OR IGNORE INTO erasures
      (key, kind, subject, reason, erased_at, confirmed)
    VALUES (?, 'person', ?, ?, ?, ?)`,
    key,
    entry.subject,
    entry.reason,
    entry.at,
    confirmed ? 1 : 0
  );
  if (found !== undefined) {
    applyPerson(sql, { key, subject: entry.subject }, found);
  }
};

/**
 * Applies a writer's erasure `key` (`entry`), asked under the change whose
 * SHA-256 is `change`: its record, which is the hide (memories.ts
 * `unerasedSql`: every memory of the writer learned before it, from this
 * statement on), kept with how many memories it covered (`memories`, as
 * its entry says on a replay; else counted now: those learned before it
 * that no earlier erasure of the writer had); and the store's stamp raised
 * to its time, so whatever is learned after it, also in an older copy it
 * is replayed into, is stamped later and kept. Costs a count of the
 * writer's memories when it counts; nothing is written per memory.
 */
const applyWriter = (
  sql: SqlStorage,
  key: string,
  entry: LedgerEntry,
  confirmed: boolean,
  { change, memories }: { change: string; memories?: number }
): void => {
  const count =
    memories ??
    sql
      .exec<{ count: number }>(
        `SELECT count(*) AS count FROM memories AS m
        WHERE m.writer_subject = ?1 AND m.learned_at < ?2
          AND NOT EXISTS (
            SELECT 1 FROM erasures AS gone WHERE ${erasedBySql("m", "gone")}
          )`,
        entry.subject,
        entry.at
      )
      .one().count;
  sql.exec(
    `INSERT OR IGNORE INTO erasures
      (key, kind, subject, reason, erased_at, confirmed, memories, change)
    VALUES (?, 'writer', ?, ?, ?, ?, ?, ?)`,
    key,
    entry.subject,
    entry.reason,
    entry.at,
    confirmed ? 1 : 0,
    count,
    change
  );
  raiseStamp(sql, entry.at);
};

/**
 * Applies the erasure `key` (`entry`): the store's record of it, and
 * everything it covers hidden. Run it in one transaction. Safe to repeat.
 * Answers the sources whose current version it hid, whose work under way
 * is to stop, and how many sources it found a version of to hide, which
 * the record keeps (`erasures.sources`); for a writer's, none
 * (`applyWriter`, with its change, and on a replay its count).
 */
const apply = (
  sql: SqlStorage,
  key: string,
  entry: LedgerEntry,
  confirmed: boolean,
  writer?: { change: string; memories?: number }
): { stopped: string[]; sources: number } => {
  if (entry.kind === "writer") {
    if (writer === undefined) {
      throw new Error("A writer's erasure names its change");
    }
    applyWriter(sql, key, entry, confirmed, writer);
    return { stopped: [], sources: 0 };
  }
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
  // Its key, if it was removed, even before any version was added: the
  // erasure closes it now, and no plain key outlives what it named.
  sql.exec("DELETE FROM removed_sources WHERE subject = ?", entry.subject);
  for (const source of sourcesOf(sql, entry.subject)) {
    // Each added in it as a group, likewise.
    sql.exec("DELETE FROM removed_sources WHERE source = ?", source);
    const rows = rowsOf(sql, source);
    sources += rows.length > 0 ? 1 : 0;
    if (hideVersions(sql, source, rows, key)) {
      stopped.push(source);
    }
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
 * Most memories one batch of a writer's erasure deletes, with their
 * names, confirmations and words (`eraseWriterBatch`), in one
 * transaction. Measured in local workerd on a laptop: a call erasing a
 * writer's 1,000 memories (each with two names, an identifier, a relation
 * and a person's confirmation), its count and this one batch with it, took
 * 91 to 100 ms against 4 to 11 ms for one memory, over three runs. The
 * bound is the 30 s of CPU a Durable Object request gets, for the call and
 * for the tick alike: far inside it. Not measured on Cloudflare.
 */
export const eraseMemoriesPerBatch = 1000;

/**
 * The memories a writer's erasure hides, still to delete: each erasure of
 * a writer, then its memories learned before it, by the writer's index.
 */
const hiddenByWritersSql = `SELECT 1 FROM erasures AS gone
CROSS JOIN memories AS m ON ${erasedBySql("m", "gone")}
WHERE gone.kind = 'writer'`;

/**
 * `?1` the writer's subject, `?2` the erasure's time, `?3`/`?4` where its
 * sweep is (`swept_learned_at`, `swept_row`), `?5` how many: the next
 * memories it hides, in the order of the writer's index (a range of
 * `memories_writer_idx`, the row as its last column), each with whether it
 * failed to delete before (`memory_erase_failures`, by its key).
 */
const sweepSql = `SELECT m.row AS row, m.learned_at AS learned_at,
  EXISTS (SELECT 1 FROM memory_erase_failures AS failed WHERE failed.memory = m.row) AS failed
FROM memories AS m
WHERE m.writer_subject = ?1 AND m.learned_at < ?2
  AND (m.learned_at, m.row) > (?3, ?4)
ORDER BY m.learned_at, m.row
LIMIT ?5`;

/**
 * `?1` how many: the memories that failed to delete, those that failed
 * least often first (`memory_erase_failures_order_idx`).
 */
const failedSql = `SELECT memory AS row FROM memory_erase_failures
ORDER BY failures, memory LIMIT ?1`;

/** How a batch of a writer's erasure went: an error's name, if a memory is left that failed. */
export interface WriterBatch {
  failed: string | null;
}

/** `error`'s name alone: never its message, which may name what it held. */
const nameOf = (error: unknown): string =>
  error instanceof Error ? error.name : "unknown";

/** A writer's erasure, as its sweep reads it. */
interface Sweeping extends Record<string, SqlStorageValue> {
  key: string;
  subject: string;
  at: number;
  swept_at: number | null;
  swept_row: number | null;
}

/**
 * Deletes up to `eraseMemoriesPerBatch` of the memories writers' and
 * people's erasures hide (forget.ts `deleteMemories`: their names, entities nothing else
 * mentions, confirmations of them and made over them, their words), and
 * the sets of readers left unused, in one transaction.
 *
 * Which ones, without reading what failed before: each erasure's sweep
 * goes on where it stopped (`sweptLearnedAt`, `sweptRow`), at most a
 * batch's worth of the memories it hides in all, and takes those that
 * never failed; then the memories that failed, those that failed least
 * often first, through their own index. What an erasure hides is fixed
 * once it is applied: what the writer adds is stamped after it (every add
 * takes `stampWrite`, after the store's stamp, which the erasure raised to
 * its time); a restore of an export passes over every memory an erasure
 * covers, also one that lands while the restore runs (restore.ts
 * `passesOverMemory`); and an older copy of the store comes back with its
 * own sweeps, its erasures replayed from none. So its sweep reads each
 * memory once, and a tick reads about a batch's worth however many failed
 * behind it.
 *
 * A batch that fails is deleted again a memory a transaction; each that
 * fails then is counted (`memory_erase_failures`), and retried after the
 * others from then on, so a batch's worth of them never holds the rest
 * back. A memory left stays hidden, as all of them are until deleted
 * (memories.ts `unerasedSql`). The sweeps move on only after, so a cut-off
 * batch takes the same memories again. Answers a failure only when a
 * memory that failed is left.
 */
export const eraseWriterBatch = (
  storage: DurableObjectStorage
): WriterBatch => {
  const { sql } = storage;
  /** `rows` deleted in one transaction, with their counts of failures: its error's name, if it failed. */
  const deleted = (rows: readonly number[]): string | null => {
    try {
      storage.transactionSync(() => {
        sql.exec(
          `DELETE FROM memory_erase_failures
          WHERE memory IN (SELECT value FROM json_each(?))`,
          JSON.stringify(rows)
        );
        for (const readerSet of new Set(deleteMemories(sql, rows))) {
          dropUnusedReaderSet(sql, readerSet);
        }
      });
      return null;
    } catch (error) {
      return nameOf(error);
    }
  };
  const fresh = new Set<number>();
  const swept: [key: string, at: number, row: number][] = [];
  let read = 0;
  for (const erasure of sql
    .exec<Sweeping>(
      `SELECT key, subject, erased_at AS at, swept_learned_at AS swept_at,
        swept_row FROM erasures WHERE kind = 'writer'
      ORDER BY subject, erased_at`
    )
    .toArray()) {
    if (read >= eraseMemoriesPerBatch) {
      break;
    }
    const next = sql
      .exec<{ row: number; learned_at: number; failed: number }>(
        sweepSql,
        erasure.subject,
        erasure.at,
        erasure.swept_at ?? -1,
        erasure.swept_row ?? -1,
        eraseMemoriesPerBatch - read
      )
      .toArray();
    read += next.length;
    for (const { row, failed } of next) {
      if (failed === 0) {
        fresh.add(row);
      }
    }
    const last = next.at(-1);
    if (last !== undefined) {
      swept.push([erasure.key, last.learned_at, last.row]);
    }
  }
  // Then the memories people's erasures hide (people.ts), each of which
  // leaves `person_erasure_memories` with it, so the first of them are
  // the next: those that never failed, by their key.
  if (read < eraseMemoriesPerBatch) {
    for (const { row } of sql
      .exec<{ row: number }>(
        `SELECT hidden.memory AS row FROM person_erasure_memories AS hidden
        WHERE NOT EXISTS (
          SELECT 1 FROM memory_erase_failures AS failed
          WHERE failed.memory = hidden.memory
        )
        ORDER BY hidden.memory LIMIT ?`,
        eraseMemoriesPerBatch - read
      )
      .toArray()) {
      fresh.add(row);
    }
  }
  const batch = [
    ...new Set([
      ...fresh,
      ...(fresh.size < eraseMemoriesPerBatch
        ? sql
            .exec<{ row: number }>(
              failedSql,
              eraseMemoriesPerBatch - fresh.size
            )
            .toArray()
            .map(({ row }) => row)
        : []),
    ]),
  ];
  let failed: string | null = null;
  if (batch.length > 0 && deleted(batch) !== null) {
    for (const row of batch) {
      const name = deleted([row]);
      if (name !== null) {
        failed ??= name;
        sql.exec(
          `INSERT INTO memory_erase_failures (memory, failures) VALUES (?1, 1)
          ON CONFLICT (memory) DO UPDATE SET failures = failures + 1`,
          row
        );
      }
    }
  }
  storage.transactionSync(() => {
    for (const [key, at, row] of swept) {
      sql.exec(
        "UPDATE erasures SET swept_learned_at = ?, swept_row = ? WHERE key = ?",
        at,
        row,
        key
      );
    }
  });
  return { failed };
};

/** A ledger entry recorded but not yet written (`confirmPending`). */
const unconfirmed = "confirmed = 0";

/**
 * Whether the tick has an erasure's work to do: versions an erasure hid
 * still to delete (`eraseBatch`), memories a writer's erasure hid
 * (`eraseWriterBatch`), or a ledger entry still to write
 * (`confirmPending`). A seek per writer's erasure.
 */
export const erasureDue = (sql: SqlStorage): boolean =>
  sql
    .exec(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM erasing_versions)
        OR EXISTS (${hiddenByWritersSql})
        OR EXISTS (SELECT 1 FROM person_erasure_memories)
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

/**
 * How many erasures still hide versions, or memories (a writer's, or a
 * person's), the tick has to delete.
 */
export const erasuresUnfinished = (sql: SqlStorage): number =>
  sql
    .exec<{ count: number }>(
      `SELECT (SELECT count(DISTINCT erasure) FROM erasing_versions)
        + (SELECT count(*) FROM erasures AS gone
          WHERE gone.kind = 'writer' AND EXISTS (
            SELECT 1 FROM memories AS m WHERE ${erasedBySql("m", "gone")}
          ))
        + (SELECT count(DISTINCT erasure) FROM person_erasure_memories) AS count`
    )
    .one().count;

/**
 * How many sources keep versions no erasure hid but have no current
 * version, so no one can read them (`hideVersions`), apart from those
 * removed on purpose (removal.ts): a count, never which.
 */
export const sourcesWithoutCurrent = (sql: SqlStorage): number =>
  sql
    .exec<{ count: number }>(
      `SELECT count(DISTINCT source) AS count FROM source_versions
      WHERE source NOT IN (SELECT source FROM current_versions)
        AND source NOT IN (SELECT source FROM removed_sources)
        AND row NOT IN (SELECT version_row FROM erasing_versions)`
    )
    .one().count;

/**
 * The erasures of sources and of writers the store applied, as its record
 * of the ledger keeps them: counts only, by kind, written to the ledger or
 * not yet, and by reason; never which, when, or the SHA-256 the ledger
 * names one by. One pass over the record, a row an erasure.
 */
export const erasuresOverview = (sql: SqlStorage): ErasuresOverview => {
  const overview: ErasuresOverview = {
    source: { written: 0, unwritten: 0 },
    writer: { written: 0, unwritten: 0 },
    byReason: { deleted: 0, retention: 0, person_erased: 0, withdrawn: 0 },
  };
  const counts = sql.exec<{
    kind: string;
    reason: string;
    confirmed: number;
    count: number;
  }>(
    `SELECT kind, reason, confirmed, count(*) AS count FROM erasures
    WHERE kind IN ('source', 'writer') GROUP BY kind, reason, confirmed`
  );
  for (const { kind, reason, confirmed, count } of counts) {
    const of = kind === "writer" ? overview.writer : overview.source;
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
}

/**
 * Writes `recorded`'s ledger entry within `ledgerWaitMs`, and confirms
 * it: throws if R2 fails. Written again, it is the same.
 */
const confirm = async (
  { storage, bucket, groups }: ErasureStore,
  { key }: Recorded
): Promise<void> => {
  const named = entryOf(key);
  let body =
    groups &&
    named?.kind === "source" &&
    isKnownGroup(storage.sql, named.subject)
      ? groupBody
      : "";
  if (named?.kind === "writer") {
    const { change, memories } = storage.sql
      .exec<{ change: string | null; memories: number | null }>(
        "SELECT change, memories FROM erasures WHERE key = ?",
        key
      )
      .one();
    body = JSON.stringify(writerBodySchema.parse({ change, memories }));
  }
  if (named?.kind === "person") {
    const subjects = storage.sql
      .exec<{ subject: string }>(
        `SELECT subject FROM person_erasure_subjects WHERE erasure = ?
        ORDER BY subject`,
        key
      )
      .toArray()
      .map(({ subject }) => subject);
    body = JSON.stringify(personBodySchema.parse({ subjects }));
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
      const entry: LedgerEntry = { kind: "source", subject, reason, at };
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

/** What a writer's erasure answers: when it was recorded, and how many memories it covered then. */
export interface WriterErasureRecord {
  /** In milliseconds: the entry's time (`LedgerEntry.at`). */
  at: number;
  memories: number;
}

/** What a repeat of a change that erased the writer for another reason is told. */
const otherReason = `${refusalPrefix} that change erased this writer for another reason`;

/** The writer's erasure asked under the change whose SHA-256 is `change`, as the store's record holds it. */
const erasureByChange = (
  sql: SqlStorage,
  subject: string,
  change: string
): (WriterErasureRecord & { reason: string }) | undefined =>
  sql
    .exec<{ at: number; memories: number | null; reason: string }>(
      `SELECT erased_at AS at, memories, reason FROM erasures
      WHERE kind = 'writer' AND subject = ? AND change = ?`,
      subject,
      change
    )
    .toArray()
    .map(({ at, memories, reason }) => ({
      at,
      memories: memories ?? 0,
      reason,
    }))
    .at(0);

/**
 * Erases every memory `writer` wrote (its lineage, `writer:<writer>`)
 * learned up to now, for `reason`, under the caller's `change`: recorded,
 * which hides them all at once (`applyWriter`), then its ledger entry
 * written, then a batch of them deleted; the tick deletes the rest.
 * Returns only once its entry is in the ledger. What the writer adds
 * afterwards is new and kept: an erasure covers what was learned before
 * its time, never the writer.
 *
 * The same change again (a retry, after a lost answer, a failed write of
 * its entry, a restart, or a restore of an older copy, whose replay
 * records it from its entry) is that erasure: its entry written if it
 * isn't yet, its time and count answered as recorded, and nothing more
 * erased, also what the writer added in between; asked for another
 * reason, it is refused. Another change is another erasure, as of now.
 * Answers alike whatever the writer held.
 */
export const eraseWriter = async (
  store: ErasureStore,
  {
    writer,
    reason,
    change,
  }: { writer: string; reason: ErasureReason; change: string }
): Promise<WriterErasureRecord> => {
  const { storage } = store;
  const { sql } = storage;
  const subject = await writerSubjectOf(writer);
  // As the ledger keeps it: no plain key in an entry.
  const changed = await subjectOf(change);
  const recorded = storage.transactionSync(() => {
    const before = erasureByChange(sql, subject, changed);
    if (before !== undefined) {
      return before;
    }
    // A stamp of the store's memories, and past every entry's time.
    const at = Math.max(nextAt(sql), nextStamp(sql));
    const entry: LedgerEntry = { kind: "writer", subject, reason, at };
    apply(sql, ledgerKeyOf(entry), entry, false, { change: changed });
    return erasureByChange(sql, subject, changed);
  });
  if (recorded === undefined) {
    throw new Error("The Brain did not record the erasure");
  }
  if (recorded.reason !== reason) {
    throw new Error(otherReason);
  }
  try {
    // Each of the writer's not yet written, the oldest first: this one
    // among them, or one an earlier call recorded.
    for (const pending of sql
      .exec<Recorded>(
        `SELECT key FROM erasures
        WHERE kind = 'writer' AND subject = ? AND confirmed = 0
        ORDER BY key`,
        subject
      )
      .toArray()) {
      // oxlint-disable-next-line no-await-in-loop -- in order, oldest first
      await confirm(store, pending);
    }
  } catch {
    // Recorded and hidden: the tick writes its entry; the caller, told,
    // tries again. Nothing of R2's error: it may name the key.
    throw new Error(notRecorded);
  }
  try {
    eraseWriterBatch(storage);
  } catch {
    // Hidden and recorded: the tick deletes the rest, and shows a failure.
  }
  return { at: recorded.at, memories: recorded.memories };
};

/** A person's erasure as the store recorded it: its key, and whether its entry is in the ledger. */
const personErasureOf = (
  sql: SqlStorage,
  subject: string
): (Recorded & { confirmed: number }) | undefined =>
  sql
    .exec<Recorded & { confirmed: number }>(
      `SELECT key, confirmed FROM erasures
      WHERE kind = 'person' AND subject = ?
      ORDER BY key LIMIT 1`,
      subject
    )
    .toArray()
    .at(0);

/**
 * Erases from the shared store what it derived about `person`, and what is
 * in their own word (people.ts): recorded with what it hides and closes in
 * one transaction, which finds their entities by `identifiers` itself, so
 * nothing lands between finding and applying; then its ledger entry
 * written, then a batch of what it hid deleted; the tick deletes the rest.
 * Returns only once its entry is in the ledger. The same person again is
 * that erasure, its entry written if it isn't yet, and nothing more
 * erased: its identifiers are those of its first call.
 */
export const erasePersonShared = async (
  store: ErasureStore,
  {
    person,
    identifiers,
    reason,
  }: {
    person: string;
    identifiers: readonly Identifier[];
    reason: ErasureReason;
  }
): Promise<void> => {
  const { storage } = store;
  const { sql } = storage;
  const subject = await personSubjectOf(person);
  const held: HeldIdentifier[] = identifiers.map((identifier) => [
    identifier.type,
    foldIdentifier(identifier),
  ]);
  const closing = await Promise.all(
    identifiers.map(async (identifier) => await identifierSubjectOf(identifier))
  );
  const recorded = storage.transactionSync(() => {
    const before = personErasureOf(sql, subject);
    if (before !== undefined) {
      return before;
    }
    const entry: LedgerEntry = {
      kind: "person",
      subject,
      reason,
      at: nextAt(sql),
    };
    const key = ledgerKeyOf(entry);
    applyPersonEntry(sql, key, entry, false, {
      people: [person],
      identifiers: held,
      subjects: closing,
    });
    return { key, confirmed: 0 };
  });
  if (recorded.confirmed === 0) {
    try {
      await confirm(store, recorded);
    } catch {
      // Recorded and hidden: the tick writes its entry; the caller, told,
      // tries again. Nothing of R2's error: it may name the key.
      throw new Error(notRecorded);
    }
  }
  try {
    eraseWriterBatch(storage);
  } catch {
    // Hidden and recorded: the tick deletes the rest, and shows a failure.
  }
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
 * Whether a replay reads `entry`'s body: a source's in a store that may
 * hold groups, for its mark (`groupBody`); a writer's always, for its
 * change and count (`WriterBody`); a person's always, for what it closed
 * (`PersonBody`).
 */
const readsEntry = (entry: LedgerEntry, groups: boolean): boolean =>
  entry.kind !== "source" || groups;

/**
 * A writer's entry's body (`WriterBody`), read within `stopAt` (throws
 * `OutOfTimeError` once it is past). One that doesn't parse throws: only
 * the store writes the ledger.
 */
const readWriterBody = async (
  bucket: BrainBucket,
  key: string,
  stopAt: number
): Promise<WriterBody> => {
  if (Date.now() >= stopAt) {
    throw new OutOfTimeError();
  }
  return writerBodySchema.parse(JSON.parse(await textOf(bucket, key)));
};

/**
 * A person's entry's body (`PersonBody`), read within `stopAt` (throws
 * `OutOfTimeError` once it is past). One that doesn't parse throws: only
 * the store writes the ledger.
 */
const readPersonBody = async (
  bucket: BrainBucket,
  key: string,
  stopAt: number
): Promise<PersonBody> => {
  if (Date.now() >= stopAt) {
    throw new OutOfTimeError();
  }
  return personBodySchema.parse(JSON.parse(await textOf(bucket, key)));
};

/** Whether this copy of the store applied the ledger's entry `key` already. */
const isApplied = (sql: SqlStorage, key: string): boolean =>
  sql.exec("SELECT 1 FROM erasures WHERE key = ?", key).toArray().length > 0;

/** What a replay read of an entry's body (`readEntry`). */
interface EntryRead {
  group?: boolean;
  writer?: WriterBody;
  /** A person's entry: what it names in this copy; undefined for a legacy body (`personBodySchema`). */
  person?: { found: PersonFound | undefined };
}

/**
 * What a replay reads of `entry`'s body, within `stopAt` (throws
 * `OutOfTimeError` once it is past): a writer's change and count; for a
 * person's, what it names in this copy, found by hashing what the copy
 * holds (people.ts `foundForReplay`: nothing lands meanwhile, as a replay
 * runs while the store takes nothing else), within the step's share of
 * hashes (`step`, throws `OutOfTimeError` past it); a source's mark of a
 * group.
 */
const readEntry = async (
  { storage, bucket }: Pick<ErasureStore, "storage" | "bucket">,
  key: string,
  entry: LedgerEntry,
  stopAt: number,
  step: { hashes: number }
): Promise<EntryRead> => {
  if (entry.kind === "writer") {
    return { writer: await readWriterBody(bucket, key, stopAt) };
  }
  if (entry.kind === "person") {
    const body = await readPersonBody(bucket, key, stopAt);
    const memo = replayMemos.get(storage) ?? { hashed: new Map() };
    replayMemos.set(storage, memo);
    return {
      person: {
        found:
          "subjects" in body
            ? await foundForReplay(
                storage.sql,
                entry.subject,
                body.subjects,
                memo,
                // Bounded by the hashes the step made, not the clock: it
                // moves only on I/O, never while it hashes.
                () => {
                  if (step.hashes >= replayHashesPerStep) {
                    throw new OutOfTimeError();
                  }
                  step.hashes += 1;
                }
              )
            : undefined,
      },
    };
  }
  return { group: await readGroupMark(bucket, key, stopAt) };
};

/**
 * One step of a replay: lists one page of the ledger after the store's
 * mark and applies, in order, the entries in it the store lacks (above),
 * each in its own transaction and recorded as confirmed. A source's entry
 * takes no read in the shared store, and one in a person's own (its body:
 * whether it was a group's); a writer's one (its body: its change and
 * count); a person's one (its body: what it closed), and hashes what the
 * copy holds to find what that names (people.ts `foundForReplay`). It
 * stops after `replayReadsPerStep` reads,
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
  const step = { hashes: 0 };
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
      const isNew = entry !== undefined && !isApplied(sql, key);
      if (isNew) {
        if (
          Date.now() >= stopAt ||
          (readsEntry(entry, groups) && reads >= replayReadsPerStep)
        ) {
          return { stopped, more: true };
        }
        let read: EntryRead = {};
        if (readsEntry(entry, groups)) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- in order, one entry at a time
            read = await readEntry(
              { storage, bucket },
              key,
              entry,
              stopAt,
              step
            );
          } catch (error) {
            if (error instanceof OutOfTimeError) {
              return { stopped, more: true };
            }
            throw error;
          }
          reads += 1;
        }
        const { group = false, writer, person } = read;
        for (const source of storage.transactionSync(() => {
          // Kept as a group's before it applies: keys under it refused,
          // though the copy restored predates the group's first add.
          if (group) {
            keepGroup(sql, entry.subject);
          }
          if (person !== undefined) {
            applyPersonEntry(sql, key, entry, true, person.found);
            return [];
          }
          return apply(sql, key, entry, true, writer).stopped;
        })) {
          stopped.push(source);
        }
        applied += 1;
      }
    }
    const last = page.objects.at(-1)?.key;
    if (applied > 0 || !page.truncated || last === undefined) {
      return stepEnded(storage, stopped, page.truncated);
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
 * since it last did covered (a writer's needs none: its record hides what
 * it covers, and the tick deletes it, `eraseWriterBatch`), as the store starts, in one transaction:
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
