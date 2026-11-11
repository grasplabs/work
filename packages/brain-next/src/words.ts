import DutchStemmer from "./snowball/dutch-stemmer.js";
import EnglishStemmer from "./snowball/english-stemmer.js";
import FrenchStemmer from "./snowball/french-stemmer.js";
import GermanStemmer from "./snowball/german-stemmer.js";
import SpanishStemmer from "./snowball/spanish-stemmer.js";
import { stopWordLists } from "./stop-words.ts";

// How text becomes words to search: one way for what is indexed and for
// what is asked, so the two can never drift apart. A chunk and a question
// both go through `wordsOf`: each word as written, folded (`foldForSearch`)
// into the word search holds, with its stems. A source is kept whole as
// given; only its chunks' words go into the word index (`chunk_words`),
// and their stems beside them (`chunk_stems`, migration 0005).
//
// Stems, so "facturen" finds "factuur" and "Rechnungen" finds "Rechnung":
// every word is reduced by the Snowball stemmers of all five languages
// recall serves (English, Dutch, German, French, Spanish; Snowball 3.2,
// src/snowball/), and two words match when they share a stem, or one is
// the other's stem. Nothing decides a language: a company writes in
// several, a document mixes them, and a reader whose screens are in
// English still asks in Dutch for a Dutch document; a guess from a
// handful of words is often wrong, and a wrong guess loses the match.
// The price is matches across languages: a word gains, besides its own
// forms, words that another language's stemmer reduces to the same stem.
// Some help (French "factures" and Spanish "facturas"), some don't
// (English "rate" and "rat", "arts" and "art"); they rank below a word
// found as written (recall.ts).
//
// A word is stemmed twice: as written, its stem then folded, and folded,
// so the French and Spanish stemmers see the accents their rules turn on
// ("employée", "arrivée", "comió"), and a word typed without its accents
// is stemmed too.
//
// What stemming can't do is left to vectors (GRA-1766): irregular forms
// ("liep" and "lopen", "steden" and "stad", "paid" and "pay", "travaux"
// and "travail"), and compounds ("zaterdagrooster" does not find "rooster
// voor de zaterdag": splitting them needs a dictionary per language). Nor
// is Chinese or Japanese text, written without spaces, cut into words: a
// run of it is one word, found when asked for whole.

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
 * the word index's tokenizer (migrations 0002 and 0005: the same
 * categories), which so only splits the words written to it at the spaces
 * between them.
 */
const wordPattern = /[\p{L}\p{N}\p{M}\p{Co}]+/gu;

/** A word holds a letter or a digit: marks alone ("❤️"'s U+FE0F) are none. */
const letterOrDigit = /[\p{L}\p{N}]/u;

/** A stem the word index takes as one word. */
const oneWord = /^[\p{L}\p{N}\p{M}\p{Co}]+$/u;

/** Most words of each kind (telling, stop) of a question that count. */
const maxTerms = 16;

/**
 * Longest word the stemmers reduce: longer than any word of the five
 * languages, compounds included. A longer run of letters is a code or
 * noise, matched only as written, and no stemmer ever sees more than this
 * many characters, so stemming stays linear in the text.
 */
const maxStemmedLength = 64;

/** Each language's Snowball stemmer, as a function of a lowercase word. */
const stemmers: readonly ((word: string) => string)[] = [
  new EnglishStemmer(),
  new DutchStemmer(),
  new GermanStemmer(),
  new FrenchStemmer(),
  new SpanishStemmer(),
].map((stemmer) => (word: string) => stemmer.stemWord(word));

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

/**
 * A word as search holds it (folded), and its stems: each distinct stem
 * any of the five stemmers gives it, as written or folded, that differs
 * from the word and is no longer than it.
 */
export interface Word {
  readonly word: string;
  readonly stems: readonly string[];
}

/** The words a word as written folds into, with their stems. */
const wordsOfWritten = (written: string): Word[] => {
  const folded = (foldForSearch(written).match(wordPattern) ?? []).filter(
    (word) => letterOrDigit.test(word)
  );
  // As written too, when it is written otherwise (accented) and folds
  // into one word alone.
  const asWritten =
    folded.length === 1 &&
    folded[0] !== written &&
    written.length <= maxStemmedLength;
  return folded.map((word) => {
    const stems = new Set<string>();
    if (word.length <= maxStemmedLength) {
      for (const stem of stemmers) {
        stems.add(stem(word));
        if (asWritten) {
          stems.add(foldForSearch(stem(written)));
        }
      }
    }
    stems.delete(word);
    return {
      word,
      stems: [...stems].filter(
        (stem) => stem.length <= word.length && oneWord.test(stem)
      ),
    };
  });
};

/**
 * The words of the texts one add indexes, by how they are written: a word
 * as written is stemmed once per add, however often its chunks hold it.
 */
export type WordMemo = Map<string, Word[]>;

/**
 * `text`'s distinct words, folded, in the order they first appear, each
 * with its stems: what the index holds of a chunk, and what a question
 * asks for. `memo` keeps the words of one add.
 */
export const wordsOf = (text: string, memo: WordMemo = new Map()): Word[] => {
  const words = new Map<string, Set<string>>();
  for (const written of new Set(
    text.normalize("NFC").toLowerCase().match(wordPattern)
  )) {
    let found = memo.get(written);
    if (found === undefined) {
      found = wordsOfWritten(written);
      memo.set(written, found);
    }
    for (const { word, stems } of found) {
      const known = words.get(word) ?? new Set<string>();
      for (const stem of stems) {
        known.add(stem);
      }
      words.set(word, known);
    }
  }
  return [...words].map(([word, stems]) => ({ word, stems: [...stems] }));
};

/** Every language's stop words, folded and cut as a question's words are. */
const stopWords: ReadonlySet<string> = new Set(
  Object.values(stopWordLists).flatMap(
    (list) => foldForSearch(list).match(wordPattern) ?? []
  )
);

/**
 * A chunk's words as the index holds them, each space-separated: its
 * distinct words as written (folded), and the distinct stems of them that
 * are not the word itself. `words` is never longer than the folded chunk
 * (distinct words, one space apart); `stems` at most ten times as long (a
 * word has at most two stems per language, none longer than the word),
 * and in prose about half as long as the chunk.
 */
export interface Indexed {
  words: string;
  stems: string;
}

/** `text`'s words and stems, as `indexWords` writes them. */
export const indexedOf = (text: string, memo?: WordMemo): Indexed => {
  const words = wordsOf(text, memo);
  return {
    words: words.map(({ word }) => word).join(" "),
    stems: [...new Set(words.flatMap(({ stems }) => stems))].join(" "),
  };
};

/** `words` as one FTS5 query: any of them, each a quoted word. */
const anyOf = (words: readonly string[]): string =>
  words.map((word) => `"${word}"`).join(" OR ");

/**
 * A telling word of a question, as two FTS5 queries: `exact` finds it as
 * written; `forms` finds it or any of its stems, asked of `chunk_words`
 * (a chunk's word is one of them) and of `chunk_stems` (one of them is
 * among a chunk's word's stems). So a chunk's word matches when the two
 * share a stem, or one is the other's stem. Built here from quoted words
 * alone, so nothing of FTS5's query syntax comes from the question.
 */
export interface Term {
  exact: string;
  forms: string;
}

/**
 * A question's words, as recall asks for them: `telling`, the words that
 * say what it is about; `stops`, its stop words, each a quoted word, which
 * only order what the telling words found. A question of stop words alone
 * ("to be or not to be") is all telling. At most `maxTerms` of each.
 */
export interface Terms {
  telling: Term[];
  stops: string[];
}

/** `question`'s terms (above). */
export const termsOf = (question: string): Terms => {
  const words = wordsOf(question);
  const telling = words.filter(({ word }) => !stopWords.has(word));
  const asked = telling.length > 0 ? telling : words;
  return {
    telling: asked.slice(0, maxTerms).map(({ word, stems }) => ({
      exact: anyOf([word]),
      forms: anyOf([word, ...stems]),
    })),
    stops:
      telling.length > 0
        ? words
            .filter(({ word }) => stopWords.has(word))
            .slice(0, maxTerms)
            .map(({ word }) => anyOf([word]))
        : [],
  };
};

/**
 * Indexes the words of the chunk at `row`, in the caller's transaction.
 * `memo` keeps the words of the add's other chunks.
 */
export const indexWords = (
  sql: SqlStorage,
  row: number,
  text: string,
  memo: WordMemo
): void => {
  const { words, stems } = indexedOf(text, memo);
  sql.exec("INSERT INTO chunk_words (rowid, text) VALUES (?, ?)", row, words);
  sql.exec("INSERT INTO chunk_stems (rowid, stems) VALUES (?, ?)", row, stems);
};

/**
 * The number of the rules by which words are indexed: bump it whenever
 * folding, the word pattern, the stemmers (a Snowball upgrade) or what the
 * indexes hold of a chunk change, and every store rebuilds its word
 * indexes from its chunks' text (`reindexWords`). The stop words are read
 * from the question alone, so changing them needs no bump. 1: words folded
 * without the primary letters, no stems; 2: stems (GRA-1725). A store marked
 * current stays so: rolled back to a release with older rules, it indexes
 * new chunks by those, and the release after does not rebuild them, since
 * the store reads current; they are recalled by the older rules until the
 * number is bumped again (nothing leaks).
 */
export const wordsVersion = 2;

/**
 * Most chunks a tick re-indexes while a store's word indexes are behind
 * (`reindexWords`), in one transaction, before its queue: the store's
 * `work`. Measured in workerd on this machine on full-size chunks (1,930
 * characters, every word different, the most stemming a chunk asks): 171
 * to 202 ms a tick for 200, about 1 ms a chunk; prose, whose words repeat,
 * costs less. A store of 100,000 chunks rebuilds in 500 ticks, some eight
 * hours at a tick a minute, while the queue runs every tick.
 */
export const reindexPerTick = 200;

/**
 * Marks the store's word indexes as built by the current rules when it
 * holds no chunks: nothing to rebuild. Run as the store starts.
 */
export const markWordsCurrentIfEmpty = (sql: SqlStorage): void => {
  sql.exec(
    `UPDATE word_index SET version = ?1, target = ?1, cursor = 0
    WHERE id = 1 AND version <> ?1 AND NOT EXISTS (SELECT 1 FROM chunks)`,
    wordsVersion
  );
};

/**
 * Rebuilds the word indexes of the next `limit` chunks, in chunk order
 * from where the last batch stopped, when the store's are behind the
 * current rules: each chunk's rows in both indexes deleted and written
 * again from its text, then the place reached saved. Run it in one
 * transaction, so a stop at any point leaves each chunk's rows whole, by
 * the old rules or the new, and the next batch starts after the last one
 * written. Past the last chunk, the store is marked current. Answers
 * whether more are left.
 *
 * Recall goes on meanwhile: a chunk not yet rebuilt answers by the rules
 * it was indexed by, so a word folded or stemmed otherwise now may miss it
 * until its turn. New and changed sources are indexed by the current rules
 * as they are added; one added during a rebuild may be rewritten once more
 * by it, the same.
 */
export const reindexWords = (
  sql: SqlStorage,
  limit: number = reindexPerTick
): boolean => {
  const state = sql
    .exec<{ version: number; target: number; cursor: number }>(
      "SELECT version, target, cursor FROM word_index WHERE id = 1"
    )
    .one();
  if (state.version === wordsVersion) {
    return false;
  }
  // A rebuild to other rules than these starts over.
  const cursor = state.target === wordsVersion ? state.cursor : 0;
  const batch = sql
    .exec<{ row: number; text: string }>(
      "SELECT row, text FROM chunks WHERE row > ? ORDER BY row LIMIT ?",
      cursor,
      limit
    )
    .toArray();
  const memo: WordMemo = new Map();
  for (const { row, text } of batch) {
    sql.exec("DELETE FROM chunk_words WHERE rowid = ?", row);
    sql.exec("DELETE FROM chunk_stems WHERE rowid = ?", row);
    indexWords(sql, row, text, memo);
  }
  const last = batch.at(-1);
  if (last === undefined || batch.length < limit) {
    sql.exec(
      "UPDATE word_index SET version = ?1, target = ?1, cursor = 0 WHERE id = 1",
      wordsVersion
    );
    return false;
  }
  sql.exec(
    "UPDATE word_index SET target = ?, cursor = ? WHERE id = 1",
    wordsVersion,
    last.row
  );
  return true;
};
