// How text becomes words to search: one folding for what is indexed and
// for what is asked, so the two can never drift apart. A source is kept
// whole as given; only its folded form goes into the word index
// (`source_words`). Later ways of matching words (stemming per language)
// extend `foldForSearch`, and with it both sides at once.

/** Combining marks, left once a character is decomposed: its accents. */
const marks = /\p{M}/gu;

/** Whatever isn't a letter or a digit separates words. */
const wordPattern = /[\p{L}\p{N}]+/gu;

/** Most words of a question that count; the rest are left out. */
const maxTerms = 16;

/**
 * `text` as search reads it: compatibility forms folded ("ﬁ" is "fi",
 * full-width "Ａ" is "a"), accents removed ("financiële" is
 * "financiele", composed or decomposed alike), lowercased.
 */
export const foldForSearch = (text: string): string =>
  text.normalize("NFKD").replace(marks, "").normalize("NFC").toLowerCase();

/**
 * A question's distinct words, folded and deduplicated on their folded
 * form, each as an FTS5 string: words only, so quoting is all it needs,
 * and nothing of FTS5's query syntax gets through.
 */
export const termsOf = (question: string): string[] =>
  [...new Set(foldForSearch(question).match(wordPattern))]
    .slice(0, maxTerms)
    .map((term) => `"${term}"`);

/** Indexes the words of the source at `row`, in the caller's transaction. */
export const indexWords = (
  sql: SqlStorage,
  row: number,
  text: string
): void => {
  sql.exec(
    "INSERT INTO source_words (rowid, text) VALUES (?, ?)",
    row,
    foldForSearch(text)
  );
};
