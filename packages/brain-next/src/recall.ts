import { recallLimit, sourceIdSchema } from "./contract.ts";
import type { Reader, Recalled } from "./contract.ts";
import { termsOf } from "./words.ts";

// Recall by words, in one statement that finds, checks and ranks.
//
// Access is part of the statement: a source whose set of readers holds
// neither the reader nor one of their groups is never ranked or returned,
// and the limit counts only what the reader may read. Principals are
// matched with their kind, so a person never matches a group of the same
// name. A set with no principals matches no one.
//
// Never BM25: its weights count a word over every row of the index, rows
// the reader can't read too, so the order of a reader's results would tell
// them how often a word is in those. A source is scored on its own words
// alone: how many of the question's words it holds; then shorter first,
// then newer, then by ID, so the order is the same whatever else is
// stored.
//
// The question never reaches FTS5's query syntax: it is folded and cut
// into words, each asked for as a quoted string (words.ts `termsOf`).

/**
 * `?1` the question's terms (JSON), `?2` the reader's person, `?3` their
 * groups (JSON), `?4` the limit. Each term is one lookup of the index, and
 * a source's score is how many of them found it. Only what the reader may
 * read is grouped and scored: a hidden match is dropped as the index finds
 * it, never grouped, counted or sorted. (The index's own lookup of a word
 * still reads its whole posting list, as any word index does.)
 */
const recallSql = `
WITH readable AS (
  SELECT reader_set FROM reader_set_members
  WHERE (kind = 'person' AND principal = ?2)
    OR (kind = 'group' AND principal IN (SELECT value FROM json_each(?3)))
),
matched AS (
  SELECT sources.row AS row, count(*) AS score
  FROM json_each(?1) AS asked
  CROSS JOIN source_words
  JOIN sources ON sources.row = source_words.rowid
  WHERE source_words MATCH asked.value
    AND sources.reader_set IN (SELECT reader_set FROM readable)
  GROUP BY sources.row
)
SELECT sources.id AS id, sources.text AS text
FROM matched
JOIN sources ON sources.row = matched.row
ORDER BY matched.score DESC, length(sources.text), sources.added_at DESC, sources.id
LIMIT ?4`;

/** What `reader` may read of the sources holding `question`'s words, best first. */
export const recall = (
  sql: SqlStorage,
  question: string,
  reader: Reader
): Recalled => {
  const terms = termsOf(question);
  if (terms.length === 0) {
    return { sources: [] };
  }
  const rows = sql
    .exec<{ id: string; text: string }>(
      recallSql,
      JSON.stringify(terms),
      reader.person,
      JSON.stringify(reader.groups),
      recallLimit
    )
    .toArray();
  return {
    sources: rows.map(({ id, text }) => ({
      id: sourceIdSchema.parse(id),
      text,
    })),
  };
};
