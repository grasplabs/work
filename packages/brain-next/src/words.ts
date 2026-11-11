import { stemmer as dutch } from "@orama/stemmers/dutch";
import { stemmer as english } from "@orama/stemmers/english";
import { stemmer as french } from "@orama/stemmers/french";
import { stemmer as german } from "@orama/stemmers/german";
import { stemmer as spanish } from "@orama/stemmers/spanish";

import { stopWordLists } from "./stop-words.ts";

// How text becomes words to search: one way for what is indexed and for
// what is asked, so the two can never drift apart. A chunk and a question
// both go through `wordsOf` (folded, cut into words, deduplicated) and
// `stemsOf` (each word's stem in each language). A source is kept whole as
// given; only its chunks' words and their stems go into the word index:
// the words as written in `chunk_words`, their stems beside them in
// `chunk_stems` (migration 0003).
//
// Stems, so "facturen" finds "factuur" and "Rechnungen" finds "Rechnung":
// every word is reduced by the Snowball stemmers of all five languages
// recall serves (English, Dutch, German, French, Spanish), each into its
// own column, and a question's word matches a chunk's word when the two
// share their stem in any one language. Nothing decides a language: a
// company writes in several, a document mixes them, and a reader whose
// screens are in English still asks in Dutch for a Dutch document. A word
// gains no false friends this way beyond each stemmer's own conflations,
// since stems are compared only within a language's column. (Stemming
// only what one guessed language says would miss a Dutch document found
// by an English-looking question and the reverse, and a guess from a
// handful of words is often wrong.) Words are folded before they are
// stemmed, so a word typed without its accents is stemmed as the accented
// one is. The index holds stems as these stemmers make them: a version of
// `@orama/stemmers` that stems differently needs the stems indexed again.
//
// Common words: the stop words of all five languages (stop-words.ts) are
// left out of a question that holds any other word, so "de", "the" or
// "un" never outweigh the word that matters. One language's stop word can
// be another's word ("war" in German, "son" in French, "men" in Dutch):
// in a question with other words it then counts for nothing.
//
// Compound words are left whole: "zaterdagrooster" does not find "rooster
// voor de zaterdag". Splitting them needs a dictionary per language; the
// vector search (GRA-1766) finds such passages by meaning instead. Nor is
// Chinese or Japanese text, written without spaces, cut into words: a run
// of it is one word, found when asked for whole.

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
 * Letters with no decomposition that Unicode's root collation still counts
 * as other letters at primary strength, the strength a search compares
 * at: "ø" is "o", "æ" is "ae", "œ" is "oe", "ß" is "ss", Greek final "ς"
 * is "σ" (as full case folding has it too). Each one is the lowercase
 * Latin or Greek letter, as folded, that `Intl.Collator("und", {
 * sensitivity: "base" })` finds equal to one or two letters of a–z (or a
 * Greek letter); a test holds the list to that. Every other letter stays
 * itself: Turkish dotless "ı" stays apart from "i", as both full case
 * folding and the root collation keep it (a dotted capital "İ" folds to
 * "i", its dot being a mark).
 */
export const primaryLetters: Readonly<Record<string, string>> = {
  æ: "ae",
  ð: "d",
  ø: "o",
  ß: "ss",
  đ: "d",
  ħ: "h",
  ł: "l",
  œ: "oe",
  ƍ: "zw",
  ƾ: "ts",
  ȸ: "db",
  ȹ: "qp",
  ʣ: "dz",
  ʦ: "ts",
  ʪ: "ls",
  ʫ: "lz",
  ς: "σ",
  ᵹ: "g",
  ᵺ: "th",
  ỻ: "ll",
  ꜩ: "tz",
  ꜳ: "aa",
  ꜵ: "ao",
  ꜷ: "au",
  ꜹ: "av",
  ꜻ: "av",
  ꜽ: "ay",
  ꝏ: "oo",
  ꝛ: "r",
  ꝡ: "vy",
  ꝺ: "d",
  ꝼ: "f",
  ꞃ: "r",
  ꞅ: "s",
  ꞇ: "t",
  ꞛ: "a",
  ꞝ: "o",
  ꞟ: "u",
  ꞡ: "g",
  ꞣ: "k",
  ꞥ: "n",
  ꞧ: "r",
  ꞩ: "s",
  ꟁ: "a",
  ꟃ: "w",
  ꟙ: "s",
  𐞀: "aa",
};

/** Any letter of `primaryLetters`, one at a time: a single linear pass. */
const primaryLetter = new RegExp(
  `[${Object.keys(primaryLetters).join("")}]`,
  "gu"
);

/**
 * What a word is made of: letters, digits, the marks that are part of
 * them, and private-use characters. Anything else separates words, as for
 * the word index's tokenizer (migrations 0002 and 0003: the same
 * categories), which so only splits the words written to it at the spaces
 * between them.
 */
const wordPattern = /[\p{L}\p{N}\p{M}\p{Co}]+/gu;

/** Most words of a question that count; the rest are left out. */
const maxTerms = 16;

/**
 * Longest word the stemmers reduce: longer than any word of the five
 * languages, compounds included. A longer run of letters is a code or
 * noise, matched only as written, and no stemmer ever sees more than this
 * many characters, so stemming stays linear in the text.
 */
const maxStemmedLength = 64;

/**
 * Each language's Snowball stemmer, by the name of its column in
 * `chunk_stems`. English is Snowball's Porter stemmer; the others are
 * Snowball's own for their language.
 */
const stemmers = {
  en: english,
  nl: dutch,
  de: german,
  fr: french,
  es: spanish,
} as const;

/** A language recall stems, as its column in `chunk_stems` is named. */
export type Language = keyof typeof stemmers;

/** The languages, in their columns' order. */
export const languages = ["en", "nl", "de", "fr", "es"] as const;

/** `valueOf` each language, by language. */
const perLanguage = <T>(
  valueOf: (language: Language) => T
): Record<Language, T> => ({
  en: valueOf("en"),
  nl: valueOf("nl"),
  de: valueOf("de"),
  fr: valueOf("fr"),
  es: valueOf("es"),
});

/**
 * `text` as search reads it: compatibility forms folded ("ﬁ" is "fi",
 * full-width "Ａ" is "a"), accents removed ("financiële" is
 * "financiele", composed or decomposed alike), lowercased, and the
 * letters search counts as others written as those ("ß" is "ss", "ø" is
 * "o"). Never more UTF-8 bytes than its compatibility form lowercased:
 * each of `primaryLetters` is replaced by as few bytes or fewer.
 */
export const foldForSearch = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(marks, "$<letter>")
    .normalize("NFC")
    .toLowerCase()
    .replace(primaryLetter, (letter) => primaryLetters[letter] ?? letter);

/** `text`'s distinct words, folded, in the order they first appear. */
export const wordsOf = (text: string): string[] => [
  ...new Set(foldForSearch(text).match(wordPattern)),
];

/**
 * `word` (folded) as each language's stemmer reduces it: the word itself
 * when it is longer than any stemmer takes, or when a stemmer would make
 * it longer, so no column of the index ever holds more than the chunk's
 * words do.
 */
export const stemsOf = (word: string): Record<Language, string> =>
  perLanguage((language) => {
    if (word.length > maxStemmedLength) {
      return word;
    }
    const stem = stemmers[language](word);
    return stem.length <= word.length ? stem : word;
  });

/** Every language's stop words, folded and cut as a question's words are. */
const stopWords: ReadonlySet<string> = new Set(
  Object.values(stopWordLists).flatMap((list) => wordsOf(list))
);

/**
 * A chunk's words as the index holds them: its distinct words as written,
 * and each language's distinct stems of them, each space-separated. No
 * column is longer than the folded chunk: distinct words, one space
 * apart, and stems no longer than their words.
 */
export interface Indexed {
  words: string;
  stems: Record<Language, string>;
}

/** `text`'s words and stems, as `indexWords` writes them. */
export const indexedOf = (text: string): Indexed => {
  const words = wordsOf(text);
  const stems = perLanguage(() => new Set<string>());
  for (const word of words) {
    const wordStems = stemsOf(word);
    for (const language of languages) {
      stems[language].add(wordStems[language]);
    }
  }
  return {
    words: words.join(" "),
    stems: perLanguage((language) => [...stems[language]].join(" ")),
  };
};

/**
 * One word of a question, as two FTS5 queries: `exact` finds the word as
 * written (in `chunk_words`), `stems` finds any word sharing its stem in
 * some language (in `chunk_stems`). Each is built here from quoted words
 * and our own column names, so nothing of FTS5's query syntax comes from
 * the question.
 */
export interface Term {
  exact: string;
  stems: string;
}

/**
 * A question's terms: its distinct words, folded and deduplicated on their
 * folded form, less the stop words when any other word is left (a
 * question of stop words alone, "to be or not to be", keeps them), the
 * first `maxTerms` of them.
 */
export const termsOf = (question: string): Term[] => {
  const words = wordsOf(question);
  const telling = words.filter((word) => !stopWords.has(word));
  return (telling.length > 0 ? telling : words)
    .slice(0, maxTerms)
    .map((word) => {
      const stems = stemsOf(word);
      return {
        exact: `"${word}"`,
        stems: languages
          .map((language) => `${language} : "${stems[language]}"`)
          .join(" OR "),
      };
    });
};

/** Indexes the words of the chunk at `row`, in the caller's transaction. */
export const indexWords = (
  sql: SqlStorage,
  row: number,
  text: string
): void => {
  const { words, stems } = indexedOf(text);
  sql.exec("INSERT INTO chunk_words (rowid, text) VALUES (?, ?)", row, words);
  sql.exec(
    "INSERT INTO chunk_stems (rowid, en, nl, de, fr, es) VALUES (?, ?, ?, ?, ?, ?)",
    row,
    stems.en,
    stems.nl,
    stems.de,
    stems.fr,
    stems.es
  );
};
