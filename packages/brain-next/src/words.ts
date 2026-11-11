// How text becomes words to search: one folding for what is indexed and
// for what is asked, so the two can never drift apart. A source is kept
// whole as given; only its chunks' folded form goes into the word index
// (`chunk_words`). Later ways of matching words (stemming per language)
// extend `foldForSearch`, and with it both sides at once.

/**
 * The marks folding removes, once a character is decomposed: those on a
 * Latin, Greek or Cyrillic letter (its accents: "ë", "é", "ñ", "ά"), and
 * the optional vowel points of Hebrew and Arabic, which most text leaves
 * out, so a pointed word is found by its plain spelling. Everywhere else a
 * mark is part of the letter (Japanese "が" and "か", Devanagari vowel
 * signs, Thai vowels) and stays, so distinct words stay distinct.
 *
 * Matched as the letter and the whole run of marks after it, and replaced
 * by the letter: one pass, linear in the text however many marks follow a
 * letter. (A lookbehind over the run would scan it again for every mark:
 * quadratic, seconds for a letter with 20,000 marks.)
 */
const marks =
  /(?<letter>[\p{sc=Latin}\p{sc=Greek}\p{sc=Cyrillic}\p{sc=Hebrew}\p{sc=Arabic}])\p{M}+/gu;

/**
 * What a word is made of: letters, digits, the marks that are part of
 * them, and private-use characters. Anything else separates words, as for
 * the word index's tokenizer (migration 0001: the same categories).
 */
const wordPattern = /[\p{L}\p{N}\p{M}\p{Co}]+/gu;

/** Most words of a question that count; the rest are left out. */
const maxTerms = 16;

/**
 * `text` as search reads it: compatibility forms folded ("ﬁ" is "fi",
 * full-width "Ａ" is "a"), accents removed ("financiële" is
 * "financiele", composed or decomposed alike), lowercased.
 */
export const foldForSearch = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(marks, "$<letter>")
    .normalize("NFC")
    .toLowerCase();

/**
 * A question's distinct words, folded and deduplicated on their folded
 * form, each as an FTS5 string: words only, so quoting is all it needs,
 * and nothing of FTS5's query syntax gets through.
 */
export const termsOf = (question: string): string[] =>
  [...new Set(foldForSearch(question).match(wordPattern))]
    .slice(0, maxTerms)
    .map((term) => `"${term}"`);

/** Indexes the words of the chunk at `row`, in the caller's transaction. */
export const indexWords = (
  sql: SqlStorage,
  row: number,
  text: string
): void => {
  sql.exec(
    "INSERT INTO chunk_words (rowid, text) VALUES (?, ?)",
    row,
    foldForSearch(text)
  );
};
