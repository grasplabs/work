import { recallLimit } from "./contract.ts";
import type { Reader, Recalled } from "./contract.ts";
import { readableSql } from "./reader-sets.ts";
import { termsOf } from "./words.ts";

// Recall by words, in one statement that finds, checks and ranks.
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
// alone: how many of the question's words it holds; then shorter first,
// then newer, then by source and place, so the order is the same whatever
// else is stored.
//
// The question never reaches FTS5's query syntax: it is folded and cut
// into words, each asked for as a quoted string (words.ts `termsOf`).

/**
 * `?1` the question's terms (JSON), `?2` the reader's person, `?3` their
 * groups (JSON), `?4` the limit. Each term is one lookup of the index, and
 * a chunk's score is how many of them found it. Only what the reader may
 * read of current versions is grouped and scored: any other match is
 * dropped as the index finds it, never grouped, counted or sorted. (The
 * index's own lookup of a word still reads its whole posting list, as any
 * word index does.)
 */
const recallSql = `
WITH ${readableSql},
matched AS (
  SELECT chunks.row AS row, count(*) AS score
  FROM json_each(?1) AS asked
  CROSS JOIN chunk_words
  JOIN chunks ON chunks.row = chunk_words.rowid
  JOIN current_versions ON current_versions.version_row = chunks.version_row
  JOIN source_versions ON source_versions.row = chunks.version_row
  WHERE chunk_words MATCH asked.value
    AND source_versions.reader_set IN (SELECT reader_set FROM readable)
  GROUP BY chunks.row
)
SELECT source_versions.source AS source, source_versions.version AS version,
  chunks.text AS text
FROM matched
JOIN chunks ON chunks.row = matched.row
JOIN source_versions ON source_versions.row = chunks.version_row
ORDER BY matched.score DESC, length(chunks.text), source_versions.added_at DESC,
  source_versions.source, chunks.position
LIMIT ?4`;

/** What `reader` may read of the chunks holding `question`'s words, best first. */
export const recall = (
  sql: SqlStorage,
  question: string,
  reader: Reader
): Recalled => {
  const terms = termsOf(question);
  if (terms.length === 0) {
    return { chunks: [] };
  }
  const rows = sql
    .exec<{ source: string; version: number; text: string }>(
      recallSql,
      JSON.stringify(terms),
      reader.person,
      JSON.stringify(reader.groups),
      recallLimit
    )
    .toArray();
  return {
    chunks: rows.map(({ source, version, text }) => ({
      source,
      version,
      text,
    })),
  };
};
