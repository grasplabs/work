import { recallLimit } from "./contract.ts";
import type { Reader, Recalled } from "./contract.ts";
import { readableSql } from "./reader-sets.ts";
import { termsOf } from "./words.ts";

// Recall by words, in one statement that finds, checks and ranks, and a
// second for the stop words alone when the first finds little.
//
// It searches the chunks of each source's current version only: a
// version is current once `current_versions` points at it, set in the
// transaction that wrote it whole, and the versions before it are
// history, read through their own call (sources.ts `readVersion`).
//
// Access is part of the statement: a chunk whose version's set of readers
// holds neither the reader nor one of their groups is never ranked or
// returned, and the limit counts only what the reader may read.
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
// same whatever else is stored. This order is the
// specification the permission harness's oracle and the evaluation
// follow.
//
// The question never reaches FTS5's query syntax: it is folded and cut
// into words, each asked for as a quoted string (words.ts `termsOf`).

/**
 * The chunks `index` finds for each of the question's telling terms (its
 * `query`, a path into the term), that the reader may read in a current
 * version: one row per chunk, term and lookup. Any other match is dropped
 * as the index finds it, never grouped, counted or sorted. (The index's
 * own lookup of a word still reads its whole posting list, as any word
 * index does.)
 */
const foundIn = (
  index: "chunk_words" | "chunk_stems",
  query: "$.exact" | "$.forms",
  exact: 0 | 1
): string => `
  SELECT chunks.row AS row, asked.key AS term, ${exact} AS exact
  FROM json_each(?1) AS asked
  CROSS JOIN ${index}
  JOIN chunks ON chunks.row = ${index}.rowid
  JOIN current_versions ON current_versions.version_row = chunks.version_row
  JOIN source_versions ON source_versions.row = chunks.version_row
  WHERE ${index} MATCH asked.value ->> '${query}'
    AND source_versions.reader_set IN (SELECT reader_set FROM readable)`;

/**
 * `?1` the question's telling terms (JSON, words.ts `Term`), `?2` the
 * reader's person, `?3` their groups (JSON), `?4` the limit, `?5` its stop
 * words (JSON). A term's forms find every chunk its exact form does, and
 * more: so `words` counts the terms a chunk holds in any form, `exact`
 * those it holds as written. Stop words are counted only for chunks
 * `matched` holds, which the reader may read: no other chunk is grouped.
 */
const recallSql = `
WITH ${readableSql},
found AS (${foundIn("chunk_words", "$.exact", 1)}
  UNION ALL${foundIn("chunk_words", "$.forms", 0)}
  UNION ALL${foundIn("chunk_stems", "$.forms", 0)}
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
SELECT chunks.row AS row, source_versions.source AS source,
  source_versions.version AS version, chunks.text AS text
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
const stopsOnlySql = `
WITH ${readableSql},
found AS (
  SELECT chunks.row AS row, asked.key AS term
  FROM json_each(?1) AS asked
  CROSS JOIN chunk_words
  JOIN chunks ON chunks.row = chunk_words.rowid
  JOIN current_versions ON current_versions.version_row = chunks.version_row
  JOIN source_versions ON source_versions.row = chunks.version_row
  WHERE chunk_words MATCH asked.value
    AND source_versions.reader_set IN (SELECT reader_set FROM readable)
    AND chunks.row NOT IN (SELECT value FROM json_each(?5))
),
matched AS (
  SELECT row, count(DISTINCT term) AS stops FROM found GROUP BY row
)
SELECT chunks.row AS row, source_versions.source AS source,
  source_versions.version AS version, chunks.text AS text
FROM matched
JOIN chunks ON chunks.row = matched.row
JOIN source_versions ON source_versions.row = chunks.version_row
ORDER BY matched.stops DESC, length(chunks.text),
  source_versions.added_at DESC, source_versions.source, chunks.position
LIMIT ?4`;

/** A chunk recall found, as its statements return it. */
interface Row extends Record<string, SqlStorageValue> {
  row: number;
  source: string;
  version: number;
  text: string;
}

/** What `reader` may read of the chunks holding `question`'s words, best first. */
export const recall = (
  sql: SqlStorage,
  question: string,
  reader: Reader
): Recalled => {
  const { telling, stops } = termsOf(question);
  if (telling.length === 0) {
    return { chunks: [] };
  }
  const found = sql
    .exec<Row>(
      recallSql,
      JSON.stringify(telling),
      reader.person,
      JSON.stringify(reader.groups),
      recallLimit,
      JSON.stringify(stops)
    )
    .toArray();
  // A question whose telling words find little is asked again by its
  // stop words alone: what they find comes after.
  const rows =
    found.length < recallLimit && stops.length > 0
      ? [
          ...found,
          ...sql
            .exec<Row>(
              stopsOnlySql,
              JSON.stringify(stops),
              reader.person,
              JSON.stringify(reader.groups),
              recallLimit - found.length,
              JSON.stringify(found.map(({ row }) => row))
            )
            .toArray(),
        ]
      : found;
  return {
    chunks: rows.map(({ source, version, text }) => ({
      source,
      version,
      text,
    })),
  };
};
