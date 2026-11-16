import { datesIn, daysIn, sameDay } from "./dates.ts";
import type { Day } from "./dates.ts";
import { allOf, sequenceOf } from "./words.ts";

// The exact way of recall: the parts of a question that must be found as
// written, word for word in that order, not word by word in any form.
// Read from the question alone, by fixed rules, so what counts as exact
// never depends on what the store holds:
//
// 1. Quoted phrases: text between double quotes of any kind ("…", “…”,
//    „…“, «…»).
// 2. IDs: a word, with - / . or _ inside it allowed and nothing else
//    (whitespace, a comma, a semicolon, a colon, brackets, quotes, or a
//    dot or other punctuation at its end ends it: "INV-123,INV-456" is
//    two, "See PO-17." and "(PO-17)" are PO-17), holding a letter and at
//    least two digits (PO-17, A12, INV-2024-0042, TK-5531, CN-2026-118),
//    or a run of five digits or more (12345, 06-12345678): a reference.
//    Everything else is words, which the words way finds: dates and times
//    in digits (2026-03-14, 09:30, 14:00-15:00), amounts, decimals and
//    fractions (1.250,00, 12.5, 1/2), numbers under five digits (2026,
//    4400), and words with one digit (2e, 3rd, 9am, A4, Q3, MP3, v2). As
//    IDs, each would get a list of its own and crowd out the passage that
//    writes it otherwise ("14 maart 2026", "tweede kwartaal"). Known and
//    accepted, the rule unchanged: v2.1, 4x4 and COVID-19 are IDs (names
//    of a kind), and so are the parts of a timestamp its colons part
//    (2026-03-14T09 and 00Z of 2026-03-14T09:00:00Z: T and Z are letters), a compact date (20260314) and an amount with five
//    digits in a row (€1250000). Such a token is found only as written,
//    and is reported in `notFound` when no passage the reader may read
//    writes it that way. #4521 is not an ID (four digits: found as a
//    word). An ID's words match in a row whatever separates them (PO-17,
//    PO 17 and PO/17 match each other), but written as one word it is
//    another word: PO17 doesn't match PO-17, nor A12 A-12.
//
// 3. Dates: a date the question writes in any form dates.ts reads, found
//    by its day however a passage writes it (GRA-1798): "14 maart 2026"
//    finds "14/03/2026" and "March 14th, 2026"; "14 maart" finds 14 March
//    of any year, and "03/04/2026" either reading. Read before the IDs,
//    so a timestamp is one date ("2026-03-14T09:00:00Z"); one inside an
//    ID is the ID's ("INV-2026-03-14-7"). A date stands for its words, as
//    an ID does, but only once it is found: its words are still the
//    words way's, so a passage writing the day in a form dates.ts doesn't
//    read, or added before days were kept, is found by them as before,
//    and the date is never said not found as a whole (across.ts).
//
// Names are left to the words way, since no rule tells a name from a
// sentence's first word or a run of German nouns.
//
// A phrase is read first and is then no longer there for the dates, nor a
// date for the IDs.
//
// What the word index holds of a chunk is its distinct words, so it finds
// the chunks holding every word of a part (`query`), and the order is
// checked here, against the chunk's text (`foundIn`). The index holds a
// chunk's distinct words in the order they first appear, so a phrase
// query on it (`near`) finds most chunks holding the part in a row,
// though not all and not only those: it orders the candidates, never
// decides.

/** A part of the question to find as written: a phrase or an ID. */
export interface Written {
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

/** A date of the question, found by its day (rule 3). */
export interface Dated {
  /** The date as the question wrote it. */
  asked: string;
  /** Its words in order (`sequenceOf`): what it stands for once found. */
  words: string[];
  /** The days it may be: two when it reads both ways. */
  days: Day[];
  kind: "date";
}

/** A part of the question to find as written, or a date by its day. */
export type Exact = Written | Dated;

/** Most exact parts of a question that count. */
const maxExacts = 8;

/** Fewest digits in a row that make a word an ID: a reference, not a year. */
const referenceDigits = 5;

/** Fewest digits that make a word with a letter an ID. */
const idDigits = 2;

/** A pair of double quotes of any kind, and what they hold. */
const quoted = /["“”„«»](?<inner>[^"“”„«»]+)["“”„«»]/gu;

/**
 * A word that may be an ID: letters and digits, with - / . or _ between
 * them, one at a time. Anything else around or between ends it.
 */
const idWord = /[\p{L}\p{N}]+(?:[-/._][\p{L}\p{N}]+)*/gu;

const digits = /\p{N}/gu;
const letter = /\p{L}/u;
const reference = new RegExp(`\\p{N}{${referenceDigits}}`, "u");

/** An exact part, or none when it holds no word. */
const exactOf = (
  asked: string,
  words: string[],
  kind: Written["kind"]
): Written | undefined =>
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
const idsOf = (text: string): Written[] =>
  (text.match(idWord) ?? []).flatMap((word) => {
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
  const dates: Dated[] = [];
  let undated = "";
  let from = 0;
  for (const { start, end, days } of datesIn(rest)) {
    const asked = rest.slice(start, end);
    dates.push({ asked, words: sequenceOf(asked), days, kind: "date" });
    undated += `${rest.slice(from, start)} `;
    from = end;
  }
  undated += rest.slice(from);
  const seen = new Set<string>();
  return [...phrases, ...dates, ...idsOf(undated)]
    .filter(({ kind, words }) => {
      const key = `${kind === "date" ? "date" : "words"} ${words.join(" ")}`;
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

/**
 * Which of `exacts` (by index, of `among`) `text` holds: a phrase or an ID
 * as written, a date by one of its days.
 */
export const foundIn = (
  text: string,
  exacts: readonly Exact[],
  among: readonly number[]
): number[] => {
  let words: string[] | undefined;
  let days: Day[] | undefined;
  return among.filter((index) => {
    const exact = exacts[index];
    if (exact === undefined) {
      return false;
    }
    if (exact.kind === "date") {
      days ??= daysIn(text);
      const written = days;
      return exact.days.some((day) =>
        written.some((other) => sameDay(day, other))
      );
    }
    words ??= sequenceOf(text);
    return holdsInARow(words, exact.words);
  });
};
