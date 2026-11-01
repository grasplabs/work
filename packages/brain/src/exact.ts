// What of a question is to be found exactly (GRA-304, the Brain design's
// "Retrieval"): identifiers ("INV-2026-0042", "GRA-304", "PO 48213"),
// dates ("2026-10-27", "27-10-2026") and phrases in quotes. Fuzzy routes
// rank these like any word and may bury them; the exact lane finds the
// sections that hold each as written, its words in a row, and the fusion
// (fusion.ts) puts what it finds first. Pure: the search asks for each as
// an FTS5 phrase (search.ts).

/** Most exact terms one question asks for; the rest are left out. */
export const exactTermsMax = 8;

/** A phrase in straight or curly double quotes, or in guillemets. */
const quotedPhrase = /["“„«](?<phrase>[^"”“«»]{2,200})["”»]/gu;

/**
 * A token that holds digits among letters or other digits, joined by a
 * separator or not: "INV-2026-0042", "A123", "2026-10-27", "48213". Plain
 * words and short numbers ("5", "12") are left to the keyword lane.
 */
const identifier =
  /(?<![\p{L}\p{N}])(?:[\p{L}]+[-_/#.]?\p{N}[\p{L}\p{N}]*(?:[-_/#.][\p{L}\p{N}]+)*|\p{N}+(?:[-_/.][\p{L}\p{N}]+)+|\p{N}{4,})(?![\p{L}\p{N}])/gu;

/** Whatever isn't a letter or a digit separates words, as the search's do. */
const wordPattern = /[\p{L}\p{N}]+/gu;

/** Most words one exact term holds. */
const phraseWordsMax = 16;

/**
 * A phrase's words in order, as the search indexes them (lowercased,
 * letters and digits), repeats kept: "10-10-2026" is three words.
 */
const termsOfPhrase = (text: string): string[] =>
  (text.normalize("NFKC").toLowerCase().match(wordPattern) ?? []).slice(
    0,
    phraseWordsMax
  );

/**
 * The exact terms of `question`, each as its words in order (as the
 * search's words are: lowercased, letters and digits), once each, quoted
 * phrases first, at most {@link exactTermsMax}.
 */
export const exactTermsOf = (question: string): string[][] => {
  const found = new Map<string, string[]>();
  const add = (text: string): void => {
    const words = termsOfPhrase(text);
    if (words.length > 0) {
      found.set(words.join(" "), words);
    }
  };
  for (const match of question.matchAll(quotedPhrase)) {
    add(match.groups?.phrase ?? "");
  }
  for (const match of question.matchAll(identifier)) {
    add(match[0]);
  }
  return [...found.values()].slice(0, exactTermsMax);
};
