import { withinTime } from "@grasp-os/shared/deadline";

import type { BrainBucket } from "./bucket.ts";
import { bucketCallMs } from "./embedding.ts";
import { fileKeyOf } from "./files.ts";
import {
  currentVersionOf,
  isHeld,
  neverJudged,
  putIn,
  putOut,
  quoteIndexOf,
} from "./quotes.ts";
import type { CurrentVersion, QuoteIndex } from "./quotes.ts";

// The catch-up of quotes (GRA-1915; the threat model is on the issue): a
// step of the store's tick that judges the sources the adds leave
// unjudged (quotes.ts), so an out memory reads current no longer than the
// catch-up takes. A source is unjudged when its pointer's `judged_row` is
// not its `version_row`: after a restore (restored pointers have none),
// after an older release moved the pointer, after new word rules (words.ts
// `reindexWords` clears every one), or after a migration that makes
// `memories` anew (which must clear them, schema.ts). The index
// `current_versions_unjudged_idx` lists them. And a memory an older
// release added unjudged, resting on an earlier version of a judged
// source, is found above the mark (`memory_judging.through`) and makes its
// source unjudged, so its source's pass judges it.
//
// A source is judged by a full pass against its current version's text,
// as a version's add with no judged version before it would
// (quotes.ts `judgeVersion`), in pages from a stored place
// (`memory_judging_places`): its out memories count for no one until the
// page that reaches the end sets `judged_row`, in its transaction, so
// every reader of the source reads them changed at once, and a page cut
// off writes nothing. Turns go round the unjudged sources in key order,
// each served before any is served again; a turn is taken before its page
// is tried, so a source that keeps failing (its file unreachable) holds no
// one else up.
//
// Each tick does a bounded amount (`catchUpLimits`), stopping at
// whichever limit it reaches first. A source with no memory on a version
// before its current one (most, after a restore) is marked judged without
// reading its file. So after a restore an out memory reads current for at
// most about the sum of (unjudged sources) / `looked`, (sources with
// memories on earlier versions) / `reads`, (their memories on earlier
// versions) / `memories`, and (memories restored) / `marked` ticks: the
// last for the mark's scan, which a restored store starts at its first
// memory, and which also finds a source a tick between the restore's parts
// marked judged before its memories arrived. Measured in the pull request.

/** What one tick of the catch-up may do. */
export interface CatchUpLimits {
  /** Unjudged sources looked at. */
  looked: number;
  /** Files read: a source with memories on a version before its current one. */
  reads: number;
  /** Memories judged. */
  memories: number;
  /** Steps of the matcher (quotes.ts `QuoteIndex.steps`): the work of judging them. */
  steps: number;
  /** Memories above the mark looked at. */
  marked: number;
}

/**
 * What one tick of the catch-up may do, a share of the tick's CPU and of
 * its invocation's subrequests:
 * - a source with nothing on an earlier version is marked judged without
 *   a read, at about a row read a source, so 10,000 take a few ms;
 * - a file read is a subrequest, of the 1,000 an invocation may make (on
 *   Workers' paid plan) that the tick's other steps share: the catch-up
 *   takes a tenth;
 * - judging an ordinary memory takes about 20 µs (part 1's full passes),
 *   so 10,000 take about 0.2 s; a step of the matcher about 10 ns, so 30
 *   million take about 0.3 s, which bounds a tick of long quotes of
 *   frequent words (GRA-1939) as well;
 * - a file's text counts a step a character (`catchUpStep`): reading and
 *   indexing a 1 MB text took about 50 to 80 ms in workerd, so a tick
 *   stops after some 30 such texts, about 2.5 s of CPU at worst, inside an
 *   invocation's 30 s;
 * - the mark's scan reads 10,000 memory rows at most.
 */
export const catchUpLimits: CatchUpLimits = {
  looked: 10_000,
  reads: 100,
  memories: 10_000,
  steps: 30_000_000,
  marked: 10_000,
};

/** The mark of memories judged, 0 when the catch-up never set one. */
const throughOf = (sql: SqlStorage): number =>
  sql
    .exec<{ through: number }>(
      "SELECT through FROM memory_judging WHERE id = 1"
    )
    .toArray()
    .at(0)?.through ?? 0;

/** Whether the catch-up has work: an unjudged source, or memories above the mark. */
export const catchUpDue = (sql: SqlStorage): boolean =>
  sql
    .exec(
      "SELECT 1 FROM current_versions WHERE judged_row IS NOT version_row LIMIT 1"
    )
    .toArray().length > 0 ||
  sql
    .exec("SELECT 1 FROM memories WHERE row > ? LIMIT 1", throughOf(sql))
    .toArray().length > 0;

/**
 * Moves the mark to `last`, an add's last memory, when no memory lies
 * between it and `first`, the add's first (each of them judged as it was
 * added: remember.ts `writeAdd`). Never sets it where there is none: only
 * the catch-up's scan does, from the first memory on.
 */
export const markJudged = (
  sql: SqlStorage,
  first: number,
  last: number
): void => {
  sql.exec(
    `UPDATE memory_judging SET through = ?2
    WHERE id = 1 AND through < ?2 AND NOT EXISTS (
      SELECT 1 FROM memories WHERE row > memory_judging.through AND row < ?1
    )`,
    first,
    last
  );
};

/** `source` unjudged: its out memories count for no one until its pass ends. */
const unjudge = (sql: SqlStorage, source: string): void => {
  sql.exec(
    "UPDATE current_versions SET judged_row = NULL WHERE source = ?",
    source
  );
  sql.exec("DELETE FROM memory_judging_places WHERE source = ?", source);
};

/**
 * The next `limit` memories above the mark looked at, in the caller's
 * transaction: the source of each one resting on an earlier version of a
 * judged source, with neither an in nor an out row (added by a release
 * that judged nothing), unjudged; then the mark moved past them.
 */
const scanMark = (sql: SqlStorage, limit: number): void => {
  const through = throughOf(sql);
  const last =
    sql
      .exec<{ row: number }>(
        "SELECT row FROM memories WHERE row > ? ORDER BY row LIMIT 1 OFFSET ?",
        through,
        limit - 1
      )
      .toArray()
      .at(0)?.row ??
    sql
      .exec<{ row: number | null }>(
        "SELECT max(row) AS row FROM memories WHERE row > ?",
        through
      )
      .one().row;
  if (last === null) {
    return;
  }
  // A memory the pass of its source would not reach: its source judged,
  // or the memory at or before the place of its source's pass under way
  // (passes go in (version, row) order). One ahead of the place is judged
  // by the pass, which is left to go on.
  const unjudged = sql
    .exec<{ source: string }>(
      `SELECT DISTINCT m.source AS source FROM memories AS m
      CROSS JOIN current_versions AS pointer ON pointer.source = m.source
      CROSS JOIN source_versions AS current ON current.row = pointer.version_row
      WHERE m.row > ?1 AND m.row <= ?2
        AND m.version < current.version
        AND NOT EXISTS (SELECT 1 FROM memory_ins WHERE memory = m.row)
        AND NOT EXISTS (SELECT 1 FROM memory_outs WHERE memory = m.row)
        AND (pointer.judged_row = pointer.version_row OR EXISTS (
          SELECT 1 FROM memory_judging_places AS place
          WHERE place.source = m.source AND place.version_row = pointer.version_row
            AND (m.version < place.after_version
              OR (m.version = place.after_version AND m.row <= place.after_row))
        ))`,
      through,
      last
    )
    .toArray();
  for (const { source } of unjudged) {
    if (!neverJudged(sql, source)) {
      unjudge(sql, source);
    }
  }
  sql.exec(
    `INSERT INTO memory_judging (id, through) VALUES (1, ?1)
    ON CONFLICT (id) DO UPDATE SET through = max(through, ?1)`,
    last
  );
};

/**
 * The unjudged source whose turn it is, taken (`memory_judging.turn`), in
 * the caller's transaction: the first after the last one served, by key,
 * or the first of all after the last; none when every source is judged.
 */
const takeTurn = (sql: SqlStorage): string | undefined => {
  const turn =
    sql
      .exec<{ turn: string | null }>(
        "SELECT turn FROM memory_judging WHERE id = 1"
      )
      .toArray()
      .at(0)?.turn ?? null;
  const firstAfter = (after: string | null): string | undefined =>
    sql
      .exec<{ source: string }>(
        `SELECT source FROM current_versions
        WHERE judged_row IS NOT version_row AND (?1 IS NULL OR source > ?1)
        ORDER BY source LIMIT 1`,
        after
      )
      .toArray()
      .at(0)?.source;
  const source = firstAfter(turn) ?? firstAfter(null);
  if (source === undefined) {
    // Nothing left: no key kept.
    sql.exec("UPDATE memory_judging SET turn = NULL WHERE id = 1");
  } else {
    sql.exec(
      `INSERT INTO memory_judging (id, through, turn) VALUES (1, 0, ?1)
      ON CONFLICT (id) DO UPDATE SET turn = ?1`,
      source
    );
  }
  return source;
};

/** What a tick of the catch-up has spent of its limits. */
interface Spent {
  memories: number;
  steps: number;
}

/** A memory of a source's pass: its row, version and quote. */
interface Judged extends Record<string, SqlStorageValue> {
  row: number;
  version: number;
  quote: string | null;
}

/**
 * The next page of `source`'s pass against `current`, with `index` its
 * text (null for a text that is gone, which holds no quote), in the
 * caller's transaction: nothing if the pointer moved since its file was
 * read (a version landed: its add judged the source, or the next turn
 * starts over); else its memories on earlier versions judged from where
 * the last page stopped, in (version, row) order, until `limits` are
 * spent, and the place kept; or, at the end, the source marked judged.
 */
const judgePage = (
  sql: SqlStorage,
  source: string,
  current: CurrentVersion,
  index: QuoteIndex | null,
  { limits, spent }: { limits: CatchUpLimits; spent: Spent }
): void => {
  const pointer = sql
    .exec<{ version_row: number; judged_row: number | null; file: string }>(
      `SELECT pointer.version_row AS version_row, pointer.judged_row AS judged_row,
        version.file AS file
      FROM current_versions AS pointer
      JOIN source_versions AS version ON version.row = pointer.version_row
      WHERE pointer.source = ?`,
      source
    )
    .toArray()
    .at(0);
  // Still the version whose file was read, by its row and its file.
  if (
    pointer === undefined ||
    pointer.version_row !== current.row ||
    pointer.file !== current.file ||
    pointer.judged_row === pointer.version_row
  ) {
    return;
  }
  const place = sql
    .exec<{ version_row: number; after_version: number; after_row: number }>(
      `SELECT version_row, after_version, after_row FROM memory_judging_places
      WHERE source = ?`,
      source
    )
    .toArray()
    .at(0);
  // A place of another version starts over: every memory is judged again.
  const from =
    place?.version_row === current.row
      ? { version: place.after_version, row: place.after_row }
      : { version: 0, row: 0 };
  const steps = index?.steps() ?? 0;
  let judged = 0;
  let last = from;
  // The source's index by version (`memories_version_idx`), its rows in
  // order: read as written, never sorted, and no memory written meanwhile.
  for (const { row, version, quote } of sql.exec<Judged>(
    `SELECT row, version, quote FROM memories
    WHERE source = ?1 AND version < ?2
      AND (version > ?3 OR (version = ?3 AND row > ?4))
    ORDER BY version, row`,
    source,
    current.version,
    from.version,
    from.row
  )) {
    const spentSteps = (index?.steps() ?? 0) - steps;
    if (
      judged > 0 &&
      (spent.memories + judged >= limits.memories ||
        spent.steps + spentSteps >= limits.steps)
    ) {
      spent.memories += judged;
      spent.steps += spentSteps;
      sql.exec(
        `INSERT INTO memory_judging_places (source, version_row, after_version, after_row)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT (source) DO UPDATE SET version_row = ?2, after_version = ?3, after_row = ?4`,
        source,
        current.row,
        last.version,
        last.row
      );
      return;
    }
    if (index !== null && isHeld(index, quote)) {
      putIn(sql, row, source);
    } else {
      putOut(sql, row, source, quote);
    }
    judged += 1;
    last = { version, row };
  }
  spent.memories += judged;
  spent.steps += (index?.steps() ?? 0) - steps;
  sql.exec(
    "UPDATE current_versions SET judged_row = version_row WHERE source = ?",
    source
  );
  sql.exec("DELETE FROM memory_judging_places WHERE source = ?", source);
};

/**
 * Whether `source`, at `current`, needs no file read: kept whole, a
 * thread, or holding no memory on a version before its current one. Then
 * it is marked judged here, with nothing to judge, in one statement that
 * asks for its pointer again (no await lies between).
 */
const nothingToJudge = (
  sql: SqlStorage,
  source: string,
  current: CurrentVersion
): boolean => {
  const none =
    neverJudged(sql, source) ||
    sql
      .exec(
        "SELECT 1 FROM memories WHERE source = ? AND version < ? LIMIT 1",
        source,
        current.version
      )
      .toArray().length === 0;
  if (none) {
    sql.exec(
      "UPDATE current_versions SET judged_row = version_row WHERE source = ? AND version_row = ?",
      source,
      current.row
    );
    sql.exec("DELETE FROM memory_judging_places WHERE source = ?", source);
  }
  return none;
};

/** The text of the file `file`, or null when it is gone, within the bucket's time. */
const textOf = async (
  bucket: BrainBucket,
  file: string
): Promise<string | null> =>
  await withinTime(async () => {
    const object = await bucket.get(fileKeyOf(file));
    return object === null ? null : await object.text();
  }, bucketCallMs);

/**
 * One tick of the catch-up (above): the memories above the mark looked
 * at, then turns of the unjudged sources, a page each, until `limits` are
 * spent or every source is judged. Throws when a file can't be read: that
 * source's turn is spent, and the next tick goes on with the next.
 */
export const catchUpStep = async (
  storage: DurableObjectStorage,
  bucket: BrainBucket,
  limits: CatchUpLimits = catchUpLimits
): Promise<void> => {
  const { sql } = storage;
  storage.transactionSync(() => {
    scanMark(sql, limits.marked);
  });
  const spent: Spent = { memories: 0, steps: 0 };
  let reads = 0;
  let read: { file: string; index: QuoteIndex | null } | undefined;
  for (let looked = 0; looked < limits.looked; looked += 1) {
    if (
      reads >= limits.reads ||
      spent.memories >= limits.memories ||
      spent.steps >= limits.steps
    ) {
      return;
    }
    const source = storage.transactionSync(() => takeTurn(sql));
    if (source === undefined) {
      return;
    }
    const current = currentVersionOf(sql, source);
    if (current === undefined) {
      continue;
    }
    if (nothingToJudge(sql, source, current)) {
      continue;
    }
    if (read?.file !== current.file) {
      reads += 1;
      // oxlint-disable-next-line no-await-in-loop -- one file at a time, a turn after another
      const text = await textOf(bucket, current.file);
      spent.steps += text?.length ?? 0;
      read = {
        file: current.file,
        index: text === null ? null : quoteIndexOf(text),
      };
    }
    const { index } = read;
    storage.transactionSync(() => {
      judgePage(sql, source, current, index, { limits, spent });
    });
  }
};
