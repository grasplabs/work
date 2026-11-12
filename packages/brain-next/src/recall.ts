import { exactCandidatesMax, recallLimit } from "./contract.ts";
import type { FoundBy, Pack, Reader, RecallRequest } from "./contract.ts";
import { monthDayOf } from "./dates.ts";
import { askedOf, foundIn } from "./exact.ts";
import type { AskedDate, Exact } from "./exact.ts";
import { fuse, packOf } from "./pack.ts";
import type { Found } from "./pack.ts";
import { readableSql } from "./reader-sets.ts";
import { sequenceOf, termsOf, wordsVersion } from "./words.ts";
import type { Term, Terms } from "./words.ts";

// Recall: two ways at once, fused by rank into a pack (pack.ts). Words,
// in one statement that finds, checks and ranks, and a second for the
// stop words alone when the first finds little; exact, in one statement
// that finds the chunks holding every word of an exact part, whose order
// is then checked in code (exact.ts).
//
// It searches the chunks of each source's current version (a version is
// current once `current_versions` points at it, set in the transaction
// that wrote it whole), or, as of a moment, of the version each source
// had then: the newest added by then. Either only where the reader is
// among that version's readers and the current version's (`searched`).
//
// Access is part of every statement: a chunk whose version's set of
// readers holds neither the reader nor one of their groups is never
// ranked, checked or returned, and every limit counts only what the reader
// may read.
//
// Never BM25: its weights count a word over every row of the index, rows
// the reader can't read too, so the order of a reader's results would tell
// them how often a word is in those. A chunk is scored on its own words
// alone, in this order:
//
// 1. how many of the question's telling words it holds, in any form (as
//    written, or sharing a stem: words.ts `termsOf`);
// 2. how many of the question's stop words it holds, as written, counted
//    only for the chunks a telling word found, so a stop word never
//    outweighs a word that matters;
// 3. how many of its telling words it holds as written, so an exact form
//    ranks above another form of the word;
// 4. shorter first, then newer, then by source and place.
//
// When the telling words find fewer chunks than the limit, the chunks only
// the stop words find come after them, in the same order (2 and 4): a
// question in other words than its answer still finds what shares its
// phrasing ("wie helpt me").
//
// A stop word's posting list is read whole, as any word's, and joined
// with the chunks found: seeking it in each found chunk instead was
// measured at 190 ms against 11 ms for 3 MB of prose. So the order is the
// same whatever else is stored. This order, the exact way's and the
// fusion are the specification the permission harness's oracle and the
// evaluation follow.
//
// The question never reaches FTS5's query syntax: it is folded and cut
// into words, each asked for as a quoted string (words.ts `termsOf`,
// exact.ts).

/** A statement's last binding: the moment as of, in milliseconds, if any. */
type AsOf = [] | [number];

/**
 * The joins and conditions that keep a statement to the chunks the reader
 * may read in the versions searched, for a statement whose `chunks` are
 * joined and whose `?2` and `?3` are the reader (`readableSql`): the
 * current versions, or, as of the moment bound at `asOf` (its parameter's
 * number), the version of each source added last by then that no
 * erasure holds (`erasing_versions`, until the tick deletes it). Either
 * only if the reader is among its readers and the source's current
 * version's: a source whose current version is erased has no pointer, so
 * it answers nothing, as `readVersion` does.
 * Ends in a WHERE the caller adds to with AND.
 */
const searched = (asOf: number | undefined): string =>
  asOf === undefined
    ? `
  JOIN current_versions ON current_versions.version_row = chunks.version_row
  JOIN source_versions ON source_versions.row = chunks.version_row
  WHERE source_versions.reader_set IN (SELECT reader_set FROM readable)`
    : `
  JOIN source_versions ON source_versions.row = chunks.version_row
  JOIN current_versions ON current_versions.source = source_versions.source
  JOIN source_versions AS current
    ON current.row = current_versions.version_row
  WHERE source_versions.added_at <= ?${asOf}
    AND source_versions.row NOT IN (SELECT version_row FROM erasing_versions)
    AND NOT EXISTS (
      SELECT 1 FROM source_versions AS later
      WHERE later.source = source_versions.source
        AND later.version > source_versions.version
        AND later.added_at <= ?${asOf}
        AND later.row NOT IN (SELECT version_row FROM erasing_versions)
    )
    AND source_versions.reader_set IN (SELECT reader_set FROM readable)
    AND current.reader_set IN (SELECT reader_set FROM readable)`;

/**
 * The chunks `index` finds for each of the question's telling terms (its
 * `query`, a path into the term), that the reader may read in a version
 * searched: one row per chunk, term and lookup. Any other match is dropped
 * as the index finds it, never grouped, counted or sorted. (The index's
 * own lookup of a word still reads its whole posting list, as any word
 * index does.)
 */
const foundBy = (
  index: "chunk_words" | "chunk_stems",
  query: "$.exact" | "$.forms",
  exact: 0 | 1,
  asOf: number | undefined
): string => `
  SELECT chunks.row AS row, asked.key AS term, ${exact} AS exact
  FROM json_each(?1) AS asked
  CROSS JOIN ${index}
  JOIN chunks ON chunks.row = ${index}.rowid${searched(asOf)}
    AND ${index} MATCH asked.value ->> '${query}'`;

/** What a statement returns of a chunk it found. */
const chunkColumns = `chunks.row AS row, source_versions.source AS source,
  source_versions.version AS version, chunks.position AS position,
  chunks.text AS text`;

/**
 * `?1` the question's telling terms (JSON, words.ts `Term`), `?2` the
 * reader's person, `?3` their groups (JSON), `?4` the limit, `?5` its stop
 * words (JSON). A term's forms find every chunk its exact form does, and
 * more: so `words` counts the terms a chunk holds in any form, `exact`
 * those it holds as written. Stop words are counted only for chunks
 * `matched` holds, which the reader may read: no other chunk is grouped.
 * Each row carries the terms (by index) that any chunk found holds: those
 * no chunk the reader may read holds are what was not found.
 */
const recallSql = (asOf: number | undefined): string => `
WITH ${readableSql},
found AS MATERIALIZED (${foundBy("chunk_words", "$.exact", 1, asOf)}
  UNION ALL${foundBy("chunk_words", "$.forms", 0, asOf)}
  UNION ALL${foundBy("chunk_stems", "$.forms", 0, asOf)}
),
matched AS (
  SELECT row, count(DISTINCT term) AS words, sum(exact) AS exact
  FROM found
  GROUP BY row
),
stopped AS (
  SELECT chunk_words.rowid AS row, count(*) AS stops
  FROM json_each(?5) AS stop
  CROSS JOIN chunk_words
  WHERE chunk_words MATCH stop.value
    AND +chunk_words.rowid IN (SELECT row FROM matched)
  GROUP BY chunk_words.rowid
),
scored AS (
  SELECT matched.*, coalesce(stopped.stops, 0) AS stops
  FROM matched
  LEFT JOIN stopped ON stopped.row = matched.row
)
SELECT ${chunkColumns},
  (SELECT json_group_array(DISTINCT term) FROM found) AS terms
FROM scored
JOIN chunks ON chunks.row = scored.row
JOIN source_versions ON source_versions.row = chunks.version_row
ORDER BY scored.words DESC, scored.stops DESC, scored.exact DESC,
  length(chunks.text), source_versions.added_at DESC, source_versions.source,
  chunks.position
LIMIT ?4`;

/**
 * The chunks only the question's stop words find, for a recall whose
 * telling words found fewer than the limit: `?1` its stop words (JSON),
 * `?2` the reader's person, `?3` their groups (JSON), `?4` how many more,
 * `?5` the chunks already found (JSON). Ranked after every chunk a telling
 * word found, by how many stop words they hold, then as above.
 */
const stopsOnlySql = (asOf: number | undefined): string => `
WITH ${readableSql},
found AS (
  SELECT chunks.row AS row, asked.key AS term
  FROM json_each(?1) AS asked
  CROSS JOIN chunk_words
  JOIN chunks ON chunks.row = chunk_words.rowid${searched(asOf)}
    AND chunk_words MATCH asked.value
    AND chunks.row NOT IN (SELECT value FROM json_each(?5))
),
matched AS (
  SELECT row, count(DISTINCT term) AS stops FROM found GROUP BY row
)
SELECT ${chunkColumns}
FROM matched
JOIN chunks ON chunks.row = matched.row
JOIN source_versions ON source_versions.row = chunks.version_row
ORDER BY matched.stops DESC, length(chunks.text),
  source_versions.added_at DESC, source_versions.source, chunks.position
LIMIT ?4`;

/**
 * `?1` the exact parts (JSON: each its index as `part`, its `query` and
 * `near`, exact.ts), `?2`
 * the reader's person, `?3` their groups (JSON), `?4` the most to check of
 * each part: the chunks the reader may read that may hold one of them,
 * each with the parts (by index) within whose most it is (`parts`), and
 * those whose most it is the first past (`past`), which are capped. The
 * cap counts only what the reader may read, in the one statement that
 * checks access: `near` only orders what `found` holds.
 */
const exactSql = (asOf: number | undefined): string => `
WITH ${readableSql},
asked AS (
  SELECT value ->> '$.part' AS key, value ->> '$.query' AS query,
    value ->> '$.near' AS near
  FROM json_each(?1)
),
found AS (
  SELECT chunks.row AS row, asked.key AS part
  FROM asked
  CROSS JOIN chunk_words
  JOIN chunks ON chunks.row = chunk_words.rowid${searched(asOf)}
    AND chunk_words MATCH asked.query
),
near AS (
  SELECT asked.key AS part, chunk_words.rowid AS row
  FROM asked
  CROSS JOIN chunk_words
  WHERE chunk_words MATCH asked.near
),
ranked AS (
  SELECT found.row AS row, found.part AS part,
    row_number() OVER (
      PARTITION BY found.part
      ORDER BY near.row IS NOT NULL DESC, length(chunks.text),
        source_versions.added_at DESC, source_versions.source, chunks.position
    ) AS rank
  FROM found
  LEFT JOIN near ON near.part = found.part AND near.row = found.row
  JOIN chunks ON chunks.row = found.row
  JOIN source_versions ON source_versions.row = chunks.version_row
)
SELECT ${chunkColumns},
  json_group_array(ranked.part) FILTER (WHERE ranked.rank <= ?4) AS parts,
  json_group_array(ranked.part) FILTER (WHERE ranked.rank > ?4) AS past
FROM ranked
JOIN chunks ON chunks.row = ranked.row
JOIN source_versions ON source_versions.row = chunks.version_row
WHERE ranked.rank <= ?4 + 1
GROUP BY chunks.row
ORDER BY length(chunks.text), source_versions.added_at DESC,
  source_versions.source, chunks.position`;

/**
 * `?1` the question's dates (JSON: each a list of the days it may be, as
 * `[year, monthday]`, year 0 for none), `?2` the reader's person, `?3`
 * their groups (JSON), `?4` the most to check of each date, `?5` the
 * question's other telling words (JSON: each its `forms` query, words.ts
 * `Term`): the chunks the reader may read that write one of its days
 * (`chunk_days`, the same year or either naming none), each with how many
 * of the other words it holds in any form (`held`), the dates (by index)
 * within whose most it is (`parts`: those holding more of the other words
 * first, then shorter, then newer), and those whose most it is the first
 * past (`past`), which are capped. As the exact way's statement, the cap
 * counts only what the reader may read.
 */
const dateSql = (asOf: number | undefined): string => `
WITH ${readableSql},
asked AS (
  SELECT asked.key AS part, day.value ->> '$[0]' AS year,
    day.value ->> '$[1]' AS monthday
  FROM json_each(?1) AS asked
  CROSS JOIN json_each(asked.value) AS day
),
found AS MATERIALIZED (
  SELECT DISTINCT chunks.row AS row, asked.part AS part
  FROM asked
  CROSS JOIN chunk_days
  JOIN chunks ON chunks.row = chunk_days.chunk${searched(asOf)}
    AND chunk_days.monthday = asked.monthday
    AND (asked.year = 0 OR chunk_days.year IN (asked.year, 0))
),
termed AS (
  SELECT chunk_words.rowid AS row, term.key AS term
  FROM json_each(?5) AS term
  CROSS JOIN chunk_words
  WHERE chunk_words MATCH term.value
    AND +chunk_words.rowid IN (SELECT row FROM found)
  UNION ALL
  SELECT chunk_stems.rowid AS row, term.key AS term
  FROM json_each(?5) AS term
  CROSS JOIN chunk_stems
  WHERE chunk_stems MATCH term.value
    AND +chunk_stems.rowid IN (SELECT row FROM found)
),
held AS (
  SELECT row, count(DISTINCT term) AS held FROM termed GROUP BY row
),
ranked AS (
  SELECT found.row AS row, found.part AS part,
    coalesce(held.held, 0) AS held,
    row_number() OVER (
      PARTITION BY found.part
      ORDER BY coalesce(held.held, 0) DESC, length(chunks.text),
        source_versions.added_at DESC, source_versions.source, chunks.position
    ) AS rank
  FROM found
  LEFT JOIN held ON held.row = found.row
  JOIN chunks ON chunks.row = found.row
  JOIN source_versions ON source_versions.row = chunks.version_row
)
SELECT ${chunkColumns}, max(ranked.held) AS held,
  json_group_array(ranked.part) FILTER (WHERE ranked.rank <= ?4) AS parts,
  json_group_array(ranked.part) FILTER (WHERE ranked.rank > ?4) AS past
FROM ranked
JOIN chunks ON chunks.row = ranked.row
JOIN source_versions ON source_versions.row = chunks.version_row
WHERE ranked.rank <= ?4 + 1
GROUP BY chunks.row
ORDER BY max(ranked.held) DESC, length(chunks.text),
  source_versions.added_at DESC, source_versions.source, chunks.position`;

/** A chunk a statement found. */
interface Row extends Record<string, SqlStorageValue> {
  row: number;
  source: string;
  version: number;
  position: number;
  text: string;
}

/** The indexes in a statement's JSON array. */
const indexesOf = (json: SqlStorageValue | undefined): number[] => {
  if (typeof json !== "string") {
    return [];
  }
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed)
    ? parsed.filter((index): index is number => typeof index === "number")
    : [];
};

/** `rows` as found by `how`. */
const foundAs = (rows: readonly Row[], how: FoundBy): Found[] =>
  rows.map(({ row, source, version, position, text }) => ({
    row,
    source,
    version,
    position,
    text,
    found: how,
  }));

/** The words way: its list, best first, and the telling terms it found. */
const byWords = (
  sql: SqlStorage,
  { telling, stops }: Terms,
  reader: Reader,
  asOf: AsOf
): { found: Found[]; terms: Set<number> } => {
  if (telling.length === 0) {
    return { found: [], terms: new Set() };
  }
  // The moment, if any, follows the five bindings of each statement.
  const as = asOf.length > 0 ? 6 : undefined;
  const rows = sql
    .exec<Row & { terms: string }>(
      recallSql(as),
      JSON.stringify(telling.map(({ exact, forms }) => ({ exact, forms }))),
      reader.person,
      JSON.stringify(reader.groups),
      recallLimit,
      JSON.stringify(stops),
      ...asOf
    )
    .toArray();
  const terms = new Set(indexesOf(rows[0]?.terms));
  // A question whose telling words find little is asked again by its
  // stop words alone: what they find comes after.
  const more =
    rows.length < recallLimit && stops.length > 0
      ? sql
          .exec<Row>(
            stopsOnlySql(as),
            JSON.stringify(stops),
            reader.person,
            JSON.stringify(reader.groups),
            recallLimit - rows.length,
            JSON.stringify(rows.map(({ row }) => row)),
            ...asOf
          )
          .toArray()
      : [];
  return {
    found: [...foundAs(rows, "words"), ...foundAs(more, "stop words")],
    terms,
  };
};

/**
 * The exact way: a list per exact part, best first, the parts it found,
 * and those it capped (`exactCandidatesMax`). A part's list holds the
 * chunks that hold it as written, in the words way's order (`byWords`), so
 * among the chunks an ID every one of them holds, the one that holds the
 * question's words comes first; then those the words way didn't list, as
 * the statement orders them. A list per part, fused with the others, so
 * chunks holding one part never crowd out those holding another.
 */
const byExact = (
  sql: SqlStorage,
  exacts: readonly Exact[],
  reader: Reader,
  asOf: AsOf,
  byWordsRank: ReadonlyMap<number, number>
): { lists: Found[][]; parts: Set<number>; capped: Set<number> } => {
  const rows =
    exacts.length === 0
      ? []
      : sql
          .exec<Row & { parts: string; past: string }>(
            exactSql(asOf.length > 0 ? 5 : undefined),
            JSON.stringify(
              exacts.map(({ query, near }, part) => ({ part, query, near }))
            ),
            reader.person,
            JSON.stringify(reader.groups),
            exactCandidatesMax,
            ...asOf
          )
          .toArray();
  const capped = new Set(rows.flatMap(({ past }) => indexesOf(past)));
  // Each chunk's words are cut once, however many parts it may hold.
  const sequences = new Map<number, string[]>();
  const holds = (row: Row, among: readonly number[]): Set<number> => {
    let words = sequences.get(row.row);
    if (words === undefined) {
      words = sequenceOf(row.text);
      sequences.set(row.row, words);
    }
    return new Set(foundIn(words, exacts, among));
  };
  const held = rows.map((row) => ({
    row,
    parts: holds(row, indexesOf(row.parts)),
  }));
  const rankOf = ({ row }: Row): number => byWordsRank.get(row) ?? recallLimit;
  const lists = exacts.map((_, part) =>
    foundAs(
      held
        .filter(({ parts }) => parts.has(part))
        .map(({ row }) => row)
        .toSorted((a, b) => rankOf(a) - rankOf(b))
        .slice(0, recallLimit),
      "exact"
    )
  );
  return {
    lists,
    parts: new Set(
      lists.flatMap((list, part) => (list.length > 0 ? [part] : []))
    ),
    capped,
  };
};

/**
 * The date way: for each date the question asks for, the chunks the
 * reader may read writing one of its days (`dateSql`), the dates it
 * found, and those it capped.
 */
const byDates = (
  sql: SqlStorage,
  dates: readonly AskedDate[],
  others: readonly Term[],
  reader: Reader,
  asOf: AsOf
): {
  rows: (Row & { parts: string; held: number })[];
  parts: Set<number>;
  capped: Set<number>;
} => {
  if (dates.length === 0) {
    return { rows: [], parts: new Set(), capped: new Set() };
  }
  const rows = sql
    .exec<Row & { parts: string; past: string; held: number }>(
      dateSql(asOf.length > 0 ? 6 : undefined),
      JSON.stringify(
        dates.map(({ days }) => days.map((day) => [day.year, monthDayOf(day)]))
      ),
      reader.person,
      JSON.stringify(reader.groups),
      exactCandidatesMax,
      JSON.stringify(others.map(({ forms }) => forms)),
      ...asOf
    )
    .toArray();
  return {
    rows,
    parts: new Set(rows.flatMap(({ parts }) => indexesOf(parts))),
    capped: new Set(rows.flatMap(({ past }) => indexesOf(past))),
  };
};

/**
 * Each date's list for the fusion. A date alone is weak evidence; a date
 * with what the question is about is strong. So when the question asks
 * other telling words besides its dates (`topical`), a date's list holds
 * only the chunks writing its day that hold at least one of them, more of
 * them first, then in the words way's order where it ranks them, then as
 * the statement orders them: a passage sharing nothing with the question
 * but the day ("Lunch 14/03") never outranks its real answers. When the
 * question is nothing but dates, a date's list holds the chunks writing
 * its day that the words way didn't list, shortest first: what they
 * missed, each passage counted once.
 */
const dateLists = (
  dates: readonly AskedDate[],
  rows: readonly (Row & { parts: string; held: number })[],
  byWordsRank: ReadonlyMap<number, number>,
  topical: boolean
): Found[][] => {
  const rankOf = ({ row }: Row): number => byWordsRank.get(row) ?? recallLimit;
  return dates.map((_, part) => {
    const writing = rows.filter(({ parts }) => indexesOf(parts).includes(part));
    return foundAs(
      (topical
        ? writing
            .filter(({ held }) => held > 0)
            .toSorted((a, b) => b.held - a.held || rankOf(a) - rankOf(b))
        : writing.filter(({ row }) => !byWordsRank.has(row))
      ).slice(0, recallLimit),
      "exact"
    );
  });
};

/** Whether the word index, and the days with it, is built by the current rules. */
const wordIndexCurrent = (sql: SqlStorage): boolean =>
  sql
    .exec<{ version: number }>("SELECT version FROM word_index WHERE id = 1")
    .one().version === wordsVersion;

/**
 * What the reader may read for the question, as a pack within its budget
 * (contract.ts `Brain.recall`): the exact way's lists, one per part, the
 * words way's, and the date way's, one per date, fused by rank (in that
 * order on a tie, each in the question's order), and the parts of the
 * question none found: its exact parts and its dates, but those capped,
 * then its telling words, but those of its IDs and dates.
 */
export const recall = (
  sql: SqlStorage,
  { question, reader, budget, asOf }: RecallRequest
): Pack => {
  const { exacts, dates } = askedOf(question);
  const terms = termsOf(question);
  // An ID or a date stands for its words: none is said not found apart.
  // A date's words stay in the words way, as any words are.
  const standing = new Set([
    ...exacts.filter(({ kind }) => kind === "id").flatMap(({ words }) => words),
    ...dates.flatMap(({ asked }) => sequenceOf(asked)),
  ]);
  const at: AsOf = asOf === undefined ? [] : [asOf.getTime()];
  const words = byWords(sql, terms, reader, at);
  const byWordsRank = new Map(words.found.map(({ row }, rank) => [row, rank]));
  const exact = byExact(sql, exacts, reader, at, byWordsRank);
  // The question's telling words besides its dates' own.
  const ofDates = new Set(dates.flatMap(({ asked }) => sequenceOf(asked)));
  const others = terms.telling.filter(({ word }) => !ofDates.has(word));
  const dated = byDates(sql, dates, others, reader, at);
  // While the word index is rebuilt to the current rules, a chunk not yet
  // reached has no days: a date is never said not found meanwhile.
  const daysWhole = wordIndexCurrent(sql);
  const notFound = [
    ...exacts
      .filter((_, index) => !exact.parts.has(index) && !exact.capped.has(index))
      .map(({ asked: part }) => part),
    ...(daysWhole
      ? dates.filter(
          (_, index) => !dated.parts.has(index) && !dated.capped.has(index)
        )
      : []
    ).map(({ asked: date }) => date),
    ...terms.telling
      .filter(
        ({ word }, index) => !words.terms.has(index) && !standing.has(word)
      )
      .map(({ word }) => word),
  ];
  return packOf(
    // The date lists after the words list: they add what it missed, so on
    // a tie the words way's own first comes first.
    fuse([
      ...exact.lists,
      words.found,
      ...dateLists(dates, dated.rows, byWordsRank, others.length > 0),
    ]),
    { terms: terms.telling, exacts, dates: dates.map(({ days }) => days) },
    budget.tokens,
    notFound
  );
};
