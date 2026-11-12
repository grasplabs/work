import { allOf, sequenceOf } from "./words.ts";

// The exact way of recall: the parts of a question that must be found as
// written, word for word in that order, not word by word in any form.
// Read from the question alone, by fixed rules, so what counts as exact
// never depends on what the store holds:
//
// 1. Quoted phrases: text between double quotes of any kind ("…", “…”,
//    „…“, «…»).
// 2. IDs: a word holding a digit and a letter (A12, PO12345), or a digit
//    and a separator inside it (INV-2024-0042, 2024/0042), or a bare
//    number of five digits or more (40417): a reference. A shorter bare
//    number (a year, an amount, a day) is a plain word, which the words
//    way finds: as an ID, a year would list every chunk that names it.
//
// Dates (found however a source writes them) wait for a parser at
// indexing (GRA-1798); names are left to the words way, since no rule
// tells a name from a sentence's first word or a run of German nouns.
//
// A phrase is read first and is then no longer there for the IDs.
//
// What the word index holds of a chunk is its distinct words, so it finds
// the chunks holding every word of a part (`query`), and the order is
// checked here, against the chunk's text (`foundIn`). The index holds a
// chunk's distinct words in the order they first appear, so a phrase
// query on it (`near`) finds most chunks holding the part in a row,
// though not all and not only those: it orders the candidates, never
// decides.

/** A part of the question to find as written. */
export interface Exact {
  /** The part as the question wrote it. */
  asked: string;
  /** Its words in order (`sequenceOf`). */
  words: string[];
  /** An FTS5 query finding the chunks that hold all its words. */
  query: string;
  /**
   * An FTS5 query finding the chunks whose distinct words hold it as a
   * phrase: likely to hold it in a row (above).
   */
  near: string;
  /**
   * Which rule read it. An ID stands for its words: a pack never says them
   * apart (recall.ts).
   */
  kind: "phrase" | "id";
}

/** Most exact parts of a question that count. */
const maxExacts = 8;

/** Fewest digits of a bare number that is an ID: a reference, not a year. */
const referenceDigits = 5;

/** A pair of double quotes of any kind, and what they hold. */
const quoted = /["“”„«»](?<inner>[^"“”„«»]+)["“”„«»]/gu;

/** What surrounds a word that isn't part of it: punctuation and symbols. */
const aroundWord = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

const digit = /\p{N}/u;
const letter = /\p{L}/u;
const separator = /[^\p{L}\p{N}]/u;
const bareReference = new RegExp(`^\\p{N}{${referenceDigits},}$`, "u");

/** An exact part, or none when it holds no word. */
const exactOf = (
  asked: string,
  words: string[],
  kind: Exact["kind"]
): Exact | undefined =>
  words.length === 0
    ? undefined
    : {
        asked,
        words,
        query: allOf(words),
        near: `"${words.join(" ")}"`,
        kind,
      };

/** Whether a word, as the question wrote it, is an ID (rule 2). */
const isId = (word: string): boolean =>
  (digit.test(word) && (letter.test(word) || separator.test(word))) ||
  bareReference.test(word);

/** The IDs among `text`'s words, in order (rule 2). */
const idsOf = (text: string): Exact[] =>
  text.split(/\s+/u).flatMap((written) => {
    const word = written.replaceAll(aroundWord, "");
    const exact = isId(word)
      ? exactOf(word, sequenceOf(word), "id")
      : undefined;
    return exact === undefined ? [] : [exact];
  });

/**
 * The parts of `question` to find as written (above), in the order the
 * rules take them, each once, at most `maxExacts`.
 */
export const exactsOf = (question: string): Exact[] => {
  const phrases: Exact[] = [];
  const rest = question.replaceAll(quoted, (whole, inner: string) => {
    const exact = exactOf(inner.trim(), sequenceOf(inner), "phrase");
    if (exact === undefined) {
      return whole;
    }
    phrases.push(exact);
    return " ";
  });
  const seen = new Set<string>();
  return [...phrases, ...idsOf(rest)]
    .filter(({ words }) => {
      const key = words.join(" ");
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, maxExacts);
};

/** Whether `words` hold `part`'s words in a row, in its order. */
const holdsInARow = (
  words: readonly string[],
  part: readonly string[]
): boolean => {
  for (let start = 0; start + part.length <= words.length; start += 1) {
    if (part.every((word, at) => words[start + at] === word)) {
      return true;
    }
  }
  return false;
};

/** Which of `exacts` (by index) `text` holds as written. */
export const foundIn = (
  text: string,
  exacts: readonly Exact[],
  among: readonly number[]
): number[] => {
  const words = sequenceOf(text);
  return among.filter((index) =>
    holdsInARow(words, exacts[index]?.words ?? [""])
  );
};
