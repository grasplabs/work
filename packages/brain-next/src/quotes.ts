import { isWholeKey } from "./contract.ts";
import { isThread } from "./erasure.ts";
import { sequenceOf } from "./words.ts";

// A memory's quote against its source's current version (GRA-1915; the
// threat model is on the issue). A memory resting on a version before
// its source's current one is out when the current version's text holds
// no run of words equal to its quote, as search folds words
// (`sequenceOf`); a quote of no words is held by no text, as extraction
// reads it. Whether a memory is out depends on two things alone, its
// quote and its source's current version, and is kept true in the
// transaction that changes either: a version's add (`judgeVersion`, from
// sources.ts `record`, against the text in hand) and a late add, a memory
// resting on a version before the current one (`judgeLate`, from
// remember.ts `writeAdd`, against the current version's file read before
// its transaction). Nothing is queued, and no version is chosen but the
// current one, which every reader who may see a memory of the source may
// read (memories.ts `visibleSql`): so whoever sees a memory out may read
// the text it was judged against.
//
// Never judged: a source kept whole (instruction files and skills,
// `isWholeKey`), and a thread (`NewSource.thread`), whose versions are
// one message each: a later message never puts out what an earlier one
// said.
//
// Out is read as ended (memories.ts `endedAtSql`), at the current
// version's add, never retired: names, finds and pins stay as for any
// ended memory. A version whose text is the current one's again is a new
// version only when a version between was another's (sources.ts
// `madeBefore` compares with the current version alone), so a text
// repeated after a narrowed version ends its out memories at the repeat,
// where a store without the narrowed version would keep the earlier time.
// That is main's own channel (version numbers, the current version's time).
//
// Cost of a version's add: its text, once, then the source's memories
// judged in (`memory_ins`), those on the version it replaces (never
// judged: they rested on the current version), and the out memories whose
// quote's first word pair the new text holds (`memory_outs.pair`), never
// the source's other out memories nor any other source's. When the
// version it replaces is not the one judged (a store before this, a
// restore, a release rolled back, new word rules) it judges every memory
// of the source once instead. Measured in workerd: see
// memories-cost.test.ts.

/** A text's words, as quotes are checked against them. */
export interface QuoteIndex {
  /** Whether `quote` is in the text as consecutive words: at least one. */
  holds: (quote: string) => boolean;
  /** The text's words and pairs of adjacent words: what `pairOf` of a quote it holds is among. */
  pairs: () => string[];
}

/** `text`, its words indexed once by where each is written. */
export const quoteIndexOf = (text: string): QuoteIndex => {
  const words = sequenceOf(text);
  const places = new Map<string, number[]>();
  for (const [at, word] of words.entries()) {
    const held = places.get(word);
    if (held === undefined) {
      places.set(word, [at]);
    } else {
      held.push(at);
    }
  }
  return {
    holds: (quote) => {
      const run = sequenceOf(quote);
      // Checked from the word with the fewest places in the text.
      let fewest: readonly number[] = [];
      let offset = -1;
      for (const [index, word] of run.entries()) {
        const at = places.get(word);
        if (at === undefined) {
          return false;
        }
        if (offset < 0 || at.length < fewest.length) {
          fewest = at;
          offset = index;
        }
      }
      return fewest.some((at) => {
        const start = at - offset;
        return (
          start >= 0 &&
          start + run.length <= words.length &&
          run.every((word, index) => words[start + index] === word)
        );
      });
    },
    pairs: () => {
      const found = new Set(places.keys());
      for (let at = 1; at < words.length; at += 1) {
        found.add(`${words[at - 1]} ${words[at]}`);
      }
      return [...found];
    },
  };
};

/**
 * What an out memory is found back by: its quote's first two words, one
 * space apart (a word never holds one), or its one word; null for a quote
 * of none, which no text holds.
 */
export const pairOf = (quote: string): string | null => {
  const [first, second] = sequenceOf(quote);
  if (first === undefined) {
    return null;
  }
  return second === undefined ? first : `${first} ${second}`;
};

/** Whether `source`'s memories are never judged: kept whole, or a thread. */
const neverJudged = (sql: SqlStorage, source: string): boolean =>
  isWholeKey(source) || isThread(sql, source) === true;

/** A memory to judge: its row and quote. */
interface Judged extends Record<string, SqlStorageValue> {
  row: number;
  quote: string | null;
}

/** Puts the memory `row` of `source` in: its quote is held. */
const putIn = (sql: SqlStorage, row: number, source: string): void => {
  sql.exec("DELETE FROM memory_outs WHERE memory = ?", row);
  sql.exec(
    "INSERT OR IGNORE INTO memory_ins (memory, source) VALUES (?, ?)",
    row,
    source
  );
};

/** Puts the memory `row` of `source` out: its quote isn't held. */
const putOut = (
  sql: SqlStorage,
  row: number,
  source: string,
  quote: string | null
): void => {
  sql.exec("DELETE FROM memory_ins WHERE memory = ?", row);
  sql.exec(
    "INSERT OR REPLACE INTO memory_outs (memory, source, pair) VALUES (?, ?, ?)",
    row,
    source,
    quote === null ? null : pairOf(quote)
  );
};

/** Whether `quote` is held by the text `index` is of. */
const isHeld = (index: QuoteIndex, quote: string | null): boolean =>
  quote !== null && index.holds(quote);

/** The version a source's current pointer named before an add moves it. */
export interface Replaced {
  /** Its number. */
  version: number;
  /** Whether the source's memories were judged against it (`judged_row`). */
  judged: boolean;
}

/**
 * Judges every memory of `source` resting on a version before `version`,
 * its new current one, against that version's text `text`, the text in
 * hand: in the transaction that makes it current, which sets
 * `judged_row` with the pointer. `replaced` is the version it replaces,
 * if any.
 */
export const judgeVersion = (
  sql: SqlStorage,
  {
    source,
    version,
    text,
    replaced,
  }: {
    source: string;
    version: number;
    text: string;
    replaced: Replaced | undefined;
  }
): void => {
  if (neverJudged(sql, source)) {
    return;
  }
  let indexed: QuoteIndex | undefined;
  const index = (): QuoteIndex => {
    indexed ??= quoteIndexOf(text);
    return indexed;
  };
  if (replaced === undefined || !replaced.judged) {
    // Every memory of the source on an earlier version, once.
    for (const { row, quote } of sql
      .exec<Judged>(
        "SELECT row, quote FROM memories WHERE source = ? AND version < ?",
        source,
        version
      )
      .toArray()) {
      if (isHeld(index(), quote)) {
        putIn(sql, row, source);
      } else {
        putOut(sql, row, source, quote);
      }
    }
    return;
  }
  // The memories judged in, then those on the version replaced, which
  // rested on the current version and were never judged.
  for (const { row, quote } of sql
    .exec<Judged>(
      `SELECT m.row AS row, m.quote AS quote FROM memory_ins AS held
      JOIN memories AS m ON m.row = held.memory
      WHERE held.source = ?`,
      source
    )
    .toArray()) {
    if (!isHeld(index(), quote)) {
      putOut(sql, row, source, quote);
    }
  }
  for (const { row, quote } of sql
    .exec<Judged>(
      "SELECT row, quote FROM memories WHERE source = ? AND version = ?",
      source,
      replaced.version
    )
    .toArray()) {
    if (isHeld(index(), quote)) {
      putIn(sql, row, source);
    } else {
      putOut(sql, row, source, quote);
    }
  }
  // Out memories whose quote is back: found by the new text's words and
  // pairs, never by reading them all.
  if (
    sql
      .exec("SELECT 1 FROM memory_outs WHERE source = ? LIMIT 1", source)
      .toArray().length === 0
  ) {
    return;
  }
  for (const { row, quote } of sql
    .exec<Judged>(
      // The text's pairs first, each a seek of the index: never the
      // source's out memories one by one.
      `SELECT m.row AS row, m.quote AS quote FROM json_each(?2) AS asked
      CROSS JOIN memory_outs AS out ON out.source = ?1 AND out.pair = asked.value
      CROSS JOIN memories AS m ON m.row = out.memory`,
      source,
      JSON.stringify(index().pairs())
    )
    .toArray()) {
    if (isHeld(index(), quote)) {
      putIn(sql, row, source);
    }
  }
};

/** A source's current version: its row, number and file. */
export interface CurrentVersion extends Record<string, SqlStorageValue> {
  row: number;
  version: number;
  file: string;
}

/** `source`'s current version, if it has one. */
export const currentVersionOf = (
  sql: SqlStorage,
  source: string
): CurrentVersion | undefined =>
  sql
    .exec<CurrentVersion>(
      `SELECT source_versions.row AS row, source_versions.version AS version,
        source_versions.file AS file
      FROM current_versions
      JOIN source_versions ON source_versions.row = current_versions.version_row
      WHERE current_versions.source = ?`,
      source
    )
    .toArray()
    .at(0);

/** The current versions' texts a late add was given, by source: each version's row and file, and its text, indexed. */
export type CurrentTexts = ReadonlyMap<
  string,
  { row: number; file: string; index: QuoteIndex }
>;

/**
 * Thrown in a late add's transaction when it holds no text of a source's
 * current version that it must judge a memory against (none read yet, or
 * a newer version landed while it read): the versions to read, for the
 * add to read and try again (remember.ts `addMemories`).
 */
export class CurrentTextsNeededError extends Error {
  readonly needed: readonly (CurrentVersion & { source: string })[];
  constructor(needed: readonly (CurrentVersion & { source: string })[]) {
    super(
      "The Brain must read the current versions a late add is judged against"
    );
    this.needed = needed;
    this.name = "CurrentTextsNeededError";
  }
}

/** A memory an add wrote: its row, and the version and quote it rests on. */
export interface Written {
  row: number;
  source: string | null;
  version: number | null;
  quote: string | null;
}

/**
 * Judges each of `written` resting on a version before its source's
 * current one against that version's text, in the add's transaction:
 * from `texts`, or `CurrentTextsNeededError` when one is missing or is no
 * longer current. A memory resting on the current version is never
 * judged against its own version.
 */
export const judgeLate = (
  sql: SqlStorage,
  written: readonly Written[],
  texts: CurrentTexts
): void => {
  const late: (Written & { source: string; current: CurrentVersion })[] = [];
  const currents = new Map<string, CurrentVersion | undefined>();
  for (const memory of written) {
    const { source, version } = memory;
    if (source === null || version === null) {
      continue;
    }
    if (!currents.has(source)) {
      currents.set(
        source,
        neverJudged(sql, source) ? undefined : currentVersionOf(sql, source)
      );
    }
    const current = currents.get(source);
    if (current !== undefined && version < current.version) {
      late.push({ ...memory, source, current });
    }
  }
  const needed = [
    ...new Map(
      late
        .filter(({ source, current }) => {
          const text = texts.get(source);
          return text?.row !== current.row || text.file !== current.file;
        })
        .map(({ source, current }) => [source, { source, ...current }])
    ).values(),
  ];
  if (needed.length > 0) {
    throw new CurrentTextsNeededError(needed);
  }
  for (const { row, source, quote } of late) {
    const text = texts.get(source);
    if (text !== undefined && isHeld(text.index, quote)) {
      putIn(sql, row, source);
    } else {
      putOut(sql, row, source, quote);
    }
  }
};

/**
 * Moves the mark of memories judged as they were added (`memory_judged`)
 * to `last`, the add's last memory, when no memory lies between it and
 * `first`, the add's first: one an older release added unjudged keeps it
 * behind. The first add sets it.
 */
export const markJudged = (
  sql: SqlStorage,
  first: number,
  last: number
): void => {
  sql.exec(
    `INSERT INTO memory_judged (id, through) VALUES (1, ?2)
    ON CONFLICT (id) DO UPDATE SET through = ?2
    WHERE NOT EXISTS (
      SELECT 1 FROM memories WHERE row > memory_judged.through AND row < ?1
    )`,
    first,
    last
  );
};
