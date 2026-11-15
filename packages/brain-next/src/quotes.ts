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
// ended memory.
//
// A version whose text and readers are the current one's again is a new
// version only when a version between was another's (sources.ts
// `madeBefore` compares with the current version alone). So a text
// repeated after a narrowed version (T for some, X for fewer, T again)
// is a third version in the store and the first one, still current, in a
// store without X. Its out memories then end at the repeat in the one and
// earlier in the other. And a memory resting on the first version whose
// quote that version itself doesn't hold (an add's quote is not checked
// against the version it cites) is out in the store, resting on a version
// before the current one, and current in the other, where it rests on the
// current version: there the state differs, not only the time. That is
// main's own channel (version numbers, the current version's time) made
// wider; nothing checks a quote against its version.
//
// Cost of a version's add: its text, once, then the source's memories
// judged in (`memory_ins`), those on the version it replaces (never
// judged: they rested on the current version), and the out memories whose
// quote's first word pair the new text holds (`memory_outs.pair`), never
// the source's other out memories nor any other source's. When the
// version it replaces is not the one judged (a store before this, a
// restore, a release rolled back, new word rules) it judges every memory
// of the source once instead. The work follows the distinct quotes it
// judges (each once, against the one text), and what it holds in memory
// is that text indexed and one row at a time. No count of rows decides
// whether a source is judged. Counted in quotes-cost.test.ts; measured in
// workerd at `judgeVersion`.

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

/** A memory to judge: its row, its quote, and what it was before this add. */
interface Candidate extends Record<string, SqlStorageValue> {
  row: number;
  quote: string | null;
  /** "in" judged in, "out" judged out, "new" never judged. */
  was: string;
}

/** Every memory of `source` on a version before `version`, by quote: a full pass. */
const everyCandidate = (
  sql: SqlStorage,
  source: string,
  version: number
): SqlStorageCursor<Candidate> =>
  sql.exec<Candidate>(
    `SELECT row, quote, 'new' AS was FROM memories
    WHERE source = ?1 AND version < ?2
    ORDER BY quote`,
    source,
    version
  );

/**
 * The memories of `source` a version's add may change, by quote: those
 * judged in, those on the version replaced, `replaced` (which rested on
 * the current version and were never judged), and the out memories whose
 * quote may be back, found by the new text's words and pairs (`pairs`),
 * each a seek of the index, never by reading them all.
 */
const changedCandidates = (
  sql: SqlStorage,
  source: string,
  replaced: number,
  pairs: () => string[]
): SqlStorageCursor<Candidate> =>
  sql.exec<Candidate>(
    `SELECT m.row AS row, m.quote AS quote, 'in' AS was
    FROM memory_ins AS held
    CROSS JOIN memories AS m ON m.row = held.memory
    WHERE held.source = ?1
    UNION ALL
    SELECT row, quote, 'new' AS was FROM memories
    WHERE source = ?1 AND version = ?2
    UNION ALL
    SELECT m.row AS row, m.quote AS quote, 'out' AS was
    FROM json_each(?3) AS asked
    CROSS JOIN memory_outs AS out ON out.source = ?1 AND out.pair = asked.value
    CROSS JOIN memories AS m ON m.row = out.memory
    ORDER BY quote`,
    source,
    replaced,
    sql
      .exec("SELECT 1 FROM memory_outs WHERE source = ? LIMIT 1", source)
      .toArray().length === 0
      ? "[]"
      : JSON.stringify(pairs())
  );

/**
 * Judges every memory of `source` resting on a version before `version`,
 * its new current one, against that version's text `text`, the text in
 * hand: in the transaction that makes it current, which sets
 * `judged_row` with the pointer. `replaced` is the version it replaces,
 * if any.
 *
 * The memories come from one statement, sorted by quote: SQLite sorts
 * them whole before it gives the first row, so the writes below never
 * change what it reads, and each distinct quote is judged once, against
 * the one text in memory, the rows streamed one at a time. No count of
 * rows decides anything: every memory of the source is judged, however
 * many, by whoever it is readable.
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
  const candidates =
    replaced === undefined || !replaced.judged
      ? everyCandidate(sql, source, version)
      : changedCandidates(sql, source, replaced.version, () => index().pairs());
  let judged: { quote: string | null; held: boolean } | undefined;
  for (const { row, quote, was } of candidates) {
    if (judged === undefined || judged.quote !== quote) {
      judged = { quote, held: isHeld(index(), quote) };
    }
    if (judged.held && was !== "in") {
      putIn(sql, row, source);
    } else if (!judged.held && was !== "out") {
      putOut(sql, row, source, quote);
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

/**
 * What a late add read of its sources' current versions, by source: each
 * version's row and file, and whether its text holds each of the add's
 * quotes citing that source (`heldIn`). Only the verdicts are kept, never
 * a text: one text is read and indexed at a time.
 */
export interface CurrentText {
  row: number;
  file: string;
  held: ReadonlyMap<string, boolean>;
}
export type CurrentTexts = ReadonlyMap<string, CurrentText>;

/**
 * Whether `text` holds each of `quotes`; with no text (its file lost),
 * none: a memory resting on it lands out, failing closed, and is current
 * again when a later version says its quote.
 */
export const heldIn = (
  text: string | null,
  quotes: Iterable<string>
): Map<string, boolean> => {
  const index = text === null ? undefined : quoteIndexOf(text);
  return new Map(
    [...quotes].map((quote) => [quote, index?.holds(quote) === true])
  );
};

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
        .filter(({ source, current, quote }) => {
          const text = texts.get(source);
          return (
            text?.row !== current.row ||
            text.file !== current.file ||
            (quote !== null && !text.held.has(quote))
          );
        })
        .map(({ source, current }) => [source, { source, ...current }])
    ).values(),
  ];
  if (needed.length > 0) {
    throw new CurrentTextsNeededError(needed);
  }
  for (const { row, source, quote } of late) {
    const text = texts.get(source);
    if (quote !== null && text?.held.get(quote) === true) {
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
