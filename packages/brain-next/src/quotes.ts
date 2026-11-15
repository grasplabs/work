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
  /**
   * Whether `quote` is in the text as consecutive words: at least one.
   * Answered once for each run of folded words, however its quotes are
   * written.
   */
  holds: (quote: string) => boolean;
  /** The text's words and pairs of adjacent words: what `pairOf` of a quote it holds is among. */
  pairs: () => string[];
  /**
   * The words compared so far, by every `holds`: at most twice the text's
   * words and the quote's for each quote checked (Knuth–Morris–Pratt), so
   * no text and quote make it more than linear.
   */
  steps: () => number;
}

/**
 * Knuth–Morris–Pratt's failure table of `run`: for each place, how long a
 * start of `run` also ends there. Counts its comparisons in `count`.
 */
const failureOf = (run: Int32Array, count: { steps: number }): Int32Array => {
  const failure = new Int32Array(run.length);
  let matched = 0;
  for (let at = 1; at < run.length; at += 1) {
    while (matched > 0 && run[at] !== run[matched]) {
      count.steps += 1;
      matched = failure[matched - 1] ?? 0;
    }
    count.steps += 1;
    if (run[at] === run[matched]) {
      matched += 1;
    }
    failure[at] = matched;
  }
  return failure;
};

/**
 * Whether `words[from, to)` holds `run`, by Knuth–Morris–Pratt with its
 * failure table: at most twice `to - from` comparisons.
 */
const holdsBetween = (
  words: Int32Array,
  { from, to }: { from: number; to: number },
  run: Int32Array,
  failure: Int32Array,
  count: { steps: number }
): boolean => {
  let matched = 0;
  for (let at = from; at < to; at += 1) {
    while (matched > 0 && words[at] !== run[matched]) {
      count.steps += 1;
      matched = failure[matched - 1] ?? 0;
    }
    count.steps += 1;
    if (words[at] === run[matched]) {
      matched += 1;
      if (matched === run.length) {
        return true;
      }
    }
  }
  return false;
};

/**
 * `text`, its folded words indexed once: each word as a number, and where
 * each is written. A quote is looked for only in the stretches of the text
 * its rarest word can start a match in (each place of that word, less its
 * place in the quote), joined where they overlap, and each stretch scanned
 * by Knuth–Morris–Pratt: so a quote costs at most a pass over the text
 * and one over itself, and a rare word far less.
 */
export const quoteIndexOf = (text: string): QuoteIndex => {
  const ids = new Map<string, number>();
  const vocabulary: string[] = [];
  const folded = sequenceOf(text);
  const words = new Int32Array(folded.length);
  const places: number[][] = [];
  for (const [at, word] of folded.entries()) {
    let id = ids.get(word);
    if (id === undefined) {
      id = vocabulary.length;
      ids.set(word, id);
      vocabulary.push(word);
      places.push([]);
    }
    words[at] = id;
    places[id]?.push(at);
  }
  const count = { steps: 0 };
  const verdicts = new Map<string, boolean>();
  const judge = (run: Int32Array): boolean => {
    let rarest = -1;
    for (const [index, id] of run.entries()) {
      if (
        rarest < 0 ||
        (places[id]?.length ?? 0) < (places[run[rarest] ?? 0]?.length ?? 0)
      ) {
        rarest = index;
      }
    }
    const failure = failureOf(run, count);
    let stretch: { from: number; to: number } | undefined;
    for (const place of places[run[rarest] ?? 0] ?? []) {
      const from = place - rarest;
      if (from < 0 || from + run.length > words.length) {
        continue;
      }
      if (stretch !== undefined && from < stretch.to) {
        stretch.to = from + run.length;
        continue;
      }
      if (
        stretch !== undefined &&
        holdsBetween(words, stretch, run, failure, count)
      ) {
        return true;
      }
      stretch = { from, to: from + run.length };
    }
    return (
      stretch !== undefined && holdsBetween(words, stretch, run, failure, count)
    );
  };
  return {
    holds: (quote) => {
      const run = sequenceOf(quote);
      const key = run.join(" ");
      const known = verdicts.get(key);
      if (known !== undefined) {
        return known;
      }
      const asIds = run.map((word) => ids.get(word));
      const held =
        run.length > 0 &&
        asIds.every((id) => id !== undefined) &&
        judge(Int32Array.from(asIds));
      verdicts.set(key, held);
      return held;
    },
    pairs: () => {
      const found = new Set(vocabulary);
      for (let at = 1; at < words.length; at += 1) {
        found.add(
          `${vocabulary[words[at - 1] ?? 0]} ${vocabulary[words[at] ?? 0]}`
        );
      }
      return [...found];
    },
    steps: () => count.steps,
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
 * change what it reads, and the rows are streamed one at a time. Each
 * run of folded words is judged once, against the one text in memory
 * (`QuoteIndex.holds`), in steps linear in the text and the quote. No
 * count of rows decides anything: every memory of the source is judged,
 * however many, by whoever it is readable.
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
  for (const { row, quote, was } of candidates) {
    const held = isHeld(index(), quote);
    if (held && was !== "in") {
      putIn(sql, row, source);
    } else if (!held && was !== "out") {
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
