import { allOf, sequenceOf } from "./words.ts";

// The exact way of recall: the parts of a question that must be found as
// written, word for word in that order, not word by word in any form.
// Read from the question alone, by fixed rules, so what counts as exact
// never depends on what the store holds:
//
// 1. Quoted phrases: text between double quotes of any kind ("…", “…”,
//    „…“, «…»).
// 2. IDs: a word, separators inside it allowed, holding a letter and at
//    least two digits (PO-17, A12, INV-2024-0042, TK-5531, CN-2026-118),
//    or a run of five digits or more (12345, 06-12345678): a reference.
//    Everything else is words, which the words way finds: dates and times
//    in digits (2026-03-14, 09:30, 14:00-15:00), amounts, decimals and
//    fractions (1.250,00, 12.5, 1/2), numbers under five digits (2026,
//    4400), and words with one digit (2e, 3rd, 9am, A4, Q3, MP3, v2). As
//    IDs, each would get a list of its own and crowd out the passage that
//    writes it otherwise ("14 maart 2026", "tweede kwartaal"). Known and
//    accepted, the rule unchanged: v2.1, 4x4 and COVID-19 are IDs (names
//    of a kind), and so are a timestamp (2026-03-14T09:00:00Z: its T and
//    Z are letters), a compact date (20260314) and an amount with five
//    digits in a row (€1250000). Such a token is found only as written,
//    and is reported in `notFound` when no passage the reader may read
//    writes it that way. #4521 is not an ID (four digits: found as a
//    word). An ID's words match in a row whatever separates them (PO-17,
//    PO 17 and PO/17 match each other), but written as one word it is
//    another word: PO17 doesn't match PO-17, nor A12 A-12.
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

/** Fewest digits in a row that make a word an ID: a reference, not a year. */
const referenceDigits = 5;

/** Fewest digits that make a word with a letter an ID. */
const idDigits = 2;

/** A pair of double quotes of any kind, and what they hold. */
const quoted = /["“”„«»](?<inner>[^"“”„«»]+)["“”„«»]/gu;

/** What surrounds a word that isn't part of it: punctuation and symbols. */
const aroundWord = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

const digits = /\p{N}/gu;
const letter = /\p{L}/u;
const reference = new RegExp(`\\p{N}{${referenceDigits}}`, "u");

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
  (letter.test(word) && (word.match(digits) ?? []).length >= idDigits) ||
  reference.test(word);

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

/** Which of `exacts` (by index) a text holds as written, given its `words` (`sequenceOf`). */
export const foundIn = (
  words: readonly string[],
  exacts: readonly Exact[],
  among: readonly number[]
): number[] =>
  among.filter((index) => holdsInARow(words, exacts[index]?.words ?? [""]));
