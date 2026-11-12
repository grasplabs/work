import { packAcross } from "./across.ts";
import {
  exactCandidatesMax,
  recallLimit,
  vectorModelNameOf,
} from "./contract.ts";
import type {
  Finding,
  OrderedPassage,
  Pack,
  Reader,
  RecallRequest,
} from "./contract.ts";
import { exactsOf } from "./exact.ts";
import type { Exact } from "./exact.ts";
import { readableSql } from "./reader-sets.ts";
import type { WayRunner } from "./recall-counts.ts";
import { findMemories, memoriesByTheirWords } from "./recall-memories.ts";
import type { Reached } from "./recall-memories.ts";
import { nearChunks } from "./vectors.ts";
import { termsOf } from "./words.ts";
import type { Terms } from "./words.ts";

// Recall: two ways at once, fused by rank into a pack (pack.ts). Words,
// in one statement that finds, checks and ranks, and a second for the
// stop words alone when the first finds little; exact, in one statement
// that finds the chunks holding every word of an exact part, whose order
// is then checked in code (exact.ts). And a third when the host gives the
// question's vector: meaning, the vector way's scan (vectors.ts), with
// the access check inside it. The host embeds the question before it
// calls, so what a store finds is one synchronous read of one snapshot
// (`find`). Each way's lists are then merged, checked and fused across
// every store recalled from, one or several (across.ts `packAcross`).
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
  chunks.text AS text, length(chunks.text) AS length,
  source_versions.added_at AS added_at`;

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
SELECT ${chunkColumns}, scored.words AS words, scored.stops AS stops,
  scored.exact AS exact,
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
SELECT ${chunkColumns}, matched.stops AS stops
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
    near.row IS NOT NULL AS near,
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
  json_group_array(ranked.part) FILTER (WHERE ranked.rank <= ?4 AND ranked.near)
    AS near_parts,
  json_group_array(ranked.part) FILTER (WHERE ranked.rank > ?4) AS past
FROM ranked
JOIN chunks ON chunks.row = ranked.row
JOIN source_versions ON source_versions.row = chunks.version_row
WHERE ranked.rank <= ?4 + 1
GROUP BY chunks.row
ORDER BY length(chunks.text), source_versions.added_at DESC,
  source_versions.source, chunks.position`;

/** A chunk a statement found, with what the ways order it by. */
interface Row extends Record<string, SqlStorageValue> {
  row: number;
  source: string;
  version: number;
  position: number;
  text: string;
  length: number;
  added_at: number;
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

/** `row` as a passage of a finding. */
const passageOf = ({
  row,
  source,
  version,
  position,
  text,
  length,
  added_at: addedAt,
}: Row): OrderedPassage => ({
  row,
  source,
  version,
  position,
  text,
  length,
  addedAt,
});

/**
 * The words way: the passages its telling words find, best first, those
 * only its stop words find when those are fewer than the limit, and the
 * telling terms it found.
 */
const byWords = (
  sql: SqlStorage,
  { telling, stops }: Terms,
  reader: Reader,
  asOf: AsOf
): Pick<Finding, "words" | "stopWords" | "terms"> => {
  // The moment, if any, follows the five bindings of each statement.
  const as = asOf.length > 0 ? 6 : undefined;
  const rows = sql
    .exec<Row & { words: number; stops: number; exact: number; terms: string }>(
      recallSql(as),
      JSON.stringify(telling.map(({ exact, forms }) => ({ exact, forms }))),
      reader.person,
      JSON.stringify(reader.groups),
      recallLimit,
      JSON.stringify(stops),
      ...asOf
    )
    .toArray();
  // A question whose telling words find little is asked again by its
  // stop words alone: what they find comes after.
  const more =
    rows.length < recallLimit && stops.length > 0
      ? sql
          .exec<Row & { stops: number }>(
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
    words: rows.map((row) => ({
      ...passageOf(row),
      words: row.words,
      stops: row.stops,
      exact: row.exact,
    })),
    stopWords: more.map((row) => ({ ...passageOf(row), stops: row.stops })),
    terms: indexesOf(rows[0]?.terms),
  };
};

/**
 * The exact way's candidates: the chunks the reader may read that may
 * hold one of the question's exact parts, each with the parts within whose
 * first `exactCandidatesMax` it is, and those it is near for; and the
 * parts capped. Which candidates hold a part as written, and each part's
 * list, are across.ts's (`packAcross`), over every store's candidates.
 */
const byExact = (
  sql: SqlStorage,
  exacts: readonly Exact[],
  reader: Reader,
  asOf: AsOf
): Pick<Finding, "exact" | "capped"> => {
  const rows = sql
    .exec<Row & { parts: string; near_parts: string; past: string }>(
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
  return {
    exact: rows.flatMap((row) => {
      const parts = indexesOf(row.parts);
      return parts.length === 0
        ? []
        : [
            {
              ...passageOf(row),
              parts,
              nearParts: indexesOf(row.near_parts),
            },
          ];
    }),
    capped: [...new Set(rows.flatMap(({ past }) => indexesOf(past)))],
  };
};

/**
 * The meaning way: the chunks the reader may read whose vectors of the
 * question's model and build are nearest its vector, best first, at most
 * `recallLimit` (vectors.ts `nearChunks`).
 */
const byMeaning = (
  sql: SqlStorage,
  meaning: NonNullable<RecallRequest["meaning"]>,
  reader: Reader
): Finding["meaning"] =>
  nearChunks(
    sql,
    vectorModelNameOf(meaning.model),
    meaning.vector,
    reader,
    recallLimit
  );

/**
 * What the reader may read for the question, found by each way, before it
 * is packed (contract.ts `Brain.find`): one synchronous read of one
 * snapshot.
 *
 * A way runs, through `way` (which counts it), only when the question has
 * something for it: telling words, exact parts, or a vector for a
 * question of some word (an empty question finds nothing by any way), and
 * by meaning never as of a moment: vectors are kept for current versions
 * only, so the scan can't tell which were current then, and nearer chunks
 * added since would take every place. A way that throws fails the recall.
 */
export const find = (
  sql: SqlStorage,
  { question, reader, asOf, meaning }: RecallRequest,
  way: WayRunner
): Finding => {
  const exacts = exactsOf(question);
  const terms = termsOf(question);
  const at: AsOf = asOf === undefined ? [] : [asOf.getTime()];
  // Memories are read as of the moment asked, or now: their two clocks
  // say what was believed and true then (recall-memories.ts).
  const memoriesAt = asOf?.getTime() ?? Date.now();
  const {
    memoryWords,
    ...words
  }: Pick<Finding, "words" | "stopWords" | "terms"> & {
    memoryWords: Reached[];
  } =
    terms.telling.length === 0
      ? { words: [], stopWords: [], terms: [], memoryWords: [] }
      : way("words", () => ({
          ...byWords(sql, terms, reader, at),
          memoryWords: memoriesByTheirWords(sql, {
            question,
            reader,
            at: memoriesAt,
          }),
        }));
  const exact =
    exacts.length === 0
      ? { exact: [], capped: [] }
      : way("exact", () => byExact(sql, exacts, reader, at));
  const meant =
    meaning === undefined ||
    terms.telling.length + exacts.length === 0 ||
    asOf !== undefined
      ? []
      : way("meaning", () => byMeaning(sql, meaning, reader));
  const memories = findMemories(
    sql,
    { question, reader, at: memoriesAt, words: memoryWords },
    way
  );
  return { ...words, ...exact, meaning: meant, memories };
};

/**
 * What the reader may read for the question, as a pack within its budget
 * (contract.ts `Brain.recall`): what this store finds (`find`), packed as
 * across.ts packs what several stores find, so one store's pack and the
 * pack of stores holding the same passages between them are the same.
 */
export const recall = (
  sql: SqlStorage,
  request: RecallRequest,
  way: WayRunner
): Pack =>
  packAcross(request.question, request.budget.tokens, [
    find(sql, request, way),
  ]);
