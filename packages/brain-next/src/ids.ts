// What an ID is, in one place: exact.ts reads a question's IDs by it, and
// dates.ts by it leaves alone a date written inside an ID, the same in a
// question and where a passage is indexed. No other rules here, so both
// can import it.
//
// An ID is a word, with - / . or _ inside it allowed and nothing else
// (whitespace, a comma, a semicolon, a colon, brackets, quotes, or a dot
// or other punctuation at its end ends it), holding a letter and at least
// two digits, or a run of five digits or more (exact.ts says which and
// why).

/** Fewest digits in a row that make a word an ID: a reference, not a year. */
const referenceDigits = 5;

/** Fewest digits that make a word with a letter an ID. */
const idDigits = 2;

/**
 * A word that may be an ID: letters and digits, with - / . or _ between
 * them, one at a time. Anything else around or between ends it.
 */
export const idWord = /[\p{L}\p{N}]+(?:[-/._][\p{L}\p{N}]+)*/gu;

const digits = /\p{N}/gu;
const letter = /\p{L}/u;
const reference = new RegExp(`\\p{N}{${referenceDigits}}`, "u");

/** Whether a word, as written, is an ID. */
export const isId = (word: string): boolean =>
  (letter.test(word) && (word.match(digits) ?? []).length >= idDigits) ||
  reference.test(word);

/** Where `text` writes its IDs: each `[start, end)`, in order. */
export const idSpansOf = (text: string): [number, number][] =>
  [...text.matchAll(idWord)]
    .filter(({ 0: word }) => isId(word))
    .map(({ 0: word, index }) => [index, index + word.length]);
