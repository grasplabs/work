import { datesIn } from "./dates.ts";
import type { Day } from "./dates.ts";
import { idWord, isId } from "./ids.ts";
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
//    Everything else is words, which the words way finds: times in digits
//    (09:30, 14:00-15:00), amounts, decimals and
//    fractions (1.250,00, 12.5, 1/2), numbers under five digits (2026,
//    4400), and words with one digit (2e, 3rd, 9am, A4, Q3, MP3, v2). As
//    IDs, each would get a list of its own and crowd out the passage that
//    writes it otherwise ("14 maart 2026", "tweede kwartaal"). Known and
//    accepted, the rule unchanged: v2.1, 4x4 and COVID-19 are IDs (names
//    of a kind), and so are a compact date (20260314, not one of the
//    date forms of dates.ts) and an amount with five
//    digits in a row (€1250000). Such a token is found only as written,
//    and is reported in `notFound` when no passage the reader may read
//    writes it that way. #4521 is not an ID (four digits: found as a
//    word). An ID's words match in a row whatever separates them (PO-17,
//    PO 17 and PO/17 match each other), but written as one word it is
//    another word: PO17 doesn't match PO-17, nor A12 A-12.
//
// Names are left to the words way, since no rule tells a name from a
// sentence's first word or a run of German nouns.
//
// A phrase is read first and is then no longer there for the IDs; nor is a
// date (dates.ts), which recall matches by the days passages write. What
// is a date and what an ID is one rule, the same in a question and where
// a passage is indexed (dates.ts `datesIn`): text that is exactly a date
// form, an ISO timestamp included (2026-03-14T09:00:00Z), is a date and no
// ID; a longer word that merely holds one (INV-2026-03-14-7,
// report-2026-03-14.pdf, PO-2026-03-01) is an ID and no date.
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

/** Most exact parts and dates of a question that count, together. */
const maxExacts = 8;

/** A pair of double quotes of any kind, and what they hold. */
const quoted = /["“”„«»](?<inner>[^"“”„«»]+)["“”„«»]/gu;

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

/** The IDs among `text`'s words, in order (rule 2). */
const idsOf = (text: string): { at: number; exact: Exact }[] =>
  [...text.matchAll(idWord)].flatMap(({ 0: word, index }) => {
    const exact = isId(word)
      ? exactOf(word, sequenceOf(word), "id")
      : undefined;
    return exact === undefined ? [] : [{ at: index, exact }];
  });
/** A date a question asks for: as it wrote it, and the days it may be. */
export interface AskedDate {
  asked: string;
  days: Day[];
}

/** `text` with `[start, end)` written over with spaces: places kept. */
const blanked = (text: string, start: number, end: number): string =>
  `${text.slice(0, start)}${" ".repeat(end - start)}${text.slice(end)}`;

/**
 * The parts of `question` to find as written (above) and the dates it
 * asks for (dates.ts), each once, at most `maxExacts` of them all in the
 * order the question writes them: past those, a part is ordinary words,
 * as any words are.
 */
export const askedOf = (
  question: string
): { exacts: Exact[]; dates: AskedDate[] } => {
  type Part = { at: number; exact: Exact } | { at: number; date: AskedDate };
  const parts: Part[] = [];
  let rest = question;
  for (const match of question.matchAll(quoted)) {
    const inner = match.groups?.inner ?? "";
    const exact = exactOf(inner.trim(), sequenceOf(inner), "phrase");
    if (exact !== undefined) {
      parts.push({ at: match.index, exact });
      rest = blanked(rest, match.index, match.index + match[0].length);
    }
  }
  for (const { start, end, days } of datesIn(rest)) {
    parts.push({ at: start, date: { asked: rest.slice(start, end), days } });
    rest = blanked(rest, start, end);
  }
  parts.push(...idsOf(rest));
  const seen = new Set<string>();
  const kept = parts
    .toSorted((a, b) => a.at - b.at)
    .filter((part) => {
      const key =
        "exact" in part
          ? `exact ${part.exact.words.join(" ")}`
          : `date ${JSON.stringify(part.date.days)}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, maxExacts);
  return {
    exacts: kept.flatMap((part) => ("exact" in part ? [part.exact] : [])),
    dates: kept.flatMap((part) => ("date" in part ? [part.date] : [])),
  };
};

/** The exact parts of `question` (`askedOf`). */
export const exactsOf = (question: string): Exact[] => askedOf(question).exacts;

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
