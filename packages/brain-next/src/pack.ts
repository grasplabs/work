import { packItemTokens } from "./contract.ts";
import type { Pack, PackItem } from "./contract.ts";
import { datesIn, sameDay } from "./dates.ts";
import type { Day } from "./dates.ts";
import { foundIn } from "./exact.ts";
import type { Exact } from "./exact.ts";
import { holdsTerm, placedOf, sequenceOf, wordsOf } from "./words.ts";
import type { Word, WordMemo } from "./words.ts";

// How what recall found becomes a pack: fused by rank, then fitted to the
// reader's token budget. Everything here works on what the reader may
// read and nothing else: the lists it is given were found inside the
// store's SQL, joined on the reader's sets (recall.ts). So the order, the
// quotes, what the budget leaves out and whether it was cut short are the
// same as in a store where nothing hidden from the reader exists.

/** A chunk one way of recall found, and how it matched. */
export interface Found extends Omit<PackItem, "whole"> {
  /** The chunk's row: the same chunk in two lists is one item. */
  row: number;
}

/**
 * Reciprocal rank fusion's constant: a list's first result scores 1/61,
 * its tenth 1/70. The usual value (Cormack, Clarke and Büttcher, 2009),
 * kept: the evaluation showed no reason to move it.
 */
const fusionK = 60;

/**
 * `lists`, each best first, as one list by reciprocal rank fusion: a
 * chunk scores the sum of 1 / (60 + its rank) over the lists that hold
 * it, so one found high by any way comes near the top, and one found by
 * several ways above one found by one. Ties go to the chunk with the
 * better rank in a list, then to the list given first. A chunk in several
 * lists keeps how the first list given found it. Only ranks count, never
 * a list's own scores, so a new way (vectors, GRA-1769) is one more list.
 */
export const fuse = (lists: readonly (readonly Found[])[]): Found[] => {
  const scored = new Map<
    number,
    { found: Found; score: number; best: number; list: number }
  >();
  for (const [list, ranked] of lists.entries()) {
    for (const [index, found] of ranked.entries()) {
      const rank = index + 1;
      const known = scored.get(found.row);
      if (known === undefined) {
        scored.set(found.row, {
          found,
          score: 1 / (fusionK + rank),
          best: rank,
          list,
        });
      } else {
        known.score += 1 / (fusionK + rank);
        if (rank < known.best) {
          known.best = rank;
          known.list = list;
        }
      }
    }
  }
  return [...scored.values()]
    .toSorted((a, b) => b.score - a.score || a.best - b.best || a.list - b.list)
    .map(({ found }) => found);
};

/** Most characters of a quote: about a sentence or two. */
export const quoteMaxLength = 400;

const sentences = new Intl.Segmenter("und", { granularity: "sentence" });

const whitespace = /\s/u;

/** `text` in pieces of at most `quoteMaxLength`, cut at whitespace where it can. */
const piecesOf = (text: string): string[] => {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > quoteMaxLength) {
    let cut = quoteMaxLength;
    while (cut > 0 && !whitespace.test(rest.charAt(cut))) {
      cut -= 1;
    }
    if (cut === 0) {
      // No whitespace: cut at the most, never inside a surrogate pair.
      cut =
        (rest.codePointAt(quoteMaxLength - 1) ?? 0) > 0xff_ff
          ? quoteMaxLength - 1
          : quoteMaxLength;
    }
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  pieces.push(rest);
  return pieces.filter((piece) => piece.length > 0);
};

/**
 * What a quote is chosen for: the question's telling words, its exact
 * parts, and its dates, each as the days it may be.
 */
export interface Asked {
  terms: readonly Word[];
  exacts: readonly Exact[];
  dates?: readonly (readonly Day[])[];
}

/** Where `text` writes any of `dates`, each `[start, end)`, in order. */
const placesOfDates = (
  text: string,
  dates: readonly (readonly Day[])[]
): [number, number][] =>
  datesIn(text)
    .filter(({ days }) =>
      dates.some((asked) =>
        asked.some((day) => days.some((written) => sameDay(written, day)))
      )
    )
    .map(({ start, end }) => [start, end]);

/**
 * Where in `text` the first of `exacts` it holds is written, `[start,
 * end)`, or none.
 */
const placeOfExact = (
  text: string,
  exacts: readonly Exact[]
): [number, number] | undefined => {
  const placed = placedOf(text);
  for (const { words } of exacts) {
    for (let start = 0; start + words.length <= placed.length; start += 1) {
      if (words.every((word, at) => placed[start + at]?.word === word)) {
        return [
          placed[start]?.start ?? 0,
          placed[start + words.length - 1]?.end ?? 0,
        ];
      }
    }
  }
  return undefined;
};

/**
 * A part of `text` of at most `quoteMaxLength` around `[start, end)`,
 * cut at whitespace on both sides (so never inside a word or a surrogate
 * pair), or the span itself when it is longer.
 */
const windowOf = (text: string, start: number, end: number): string => {
  const room = quoteMaxLength - (end - start);
  if (room <= 0) {
    return text.slice(start, end);
  }
  const to = Math.min(
    text.length,
    Math.max(0, start - Math.floor(room / 2)) + quoteMaxLength
  );
  let from = Math.max(0, to - quoteMaxLength);
  let cut = to;
  // Whole words only: start just past whitespace, end just before it,
  // never into the span.
  while (from < start && !whitespace.test(text.charAt(from - 1)) && from > 0) {
    from += 1;
  }
  while (cut > end && cut < text.length && !whitespace.test(text.charAt(cut))) {
    cut -= 1;
  }
  return text.slice(from, cut).trim();
};

/**
 * The part of `text` that best answers `asked`: its sentence (or, for a
 * sentence over `quoteMaxLength`, its piece) holding the most of the
 * question's exact parts, then the most of its telling words in any form;
 * the first on a tie. The text itself when it is one such part. When the
 * text holds an exact part that no piece holds whole (it crosses where a
 * long sentence is cut), a window of at most `quoteMaxLength` around it
 * instead, so a quote of a chunk found as exact always holds what it was
 * found by.
 */
export const quoteOf = (
  text: string,
  { terms, exacts, dates = [] }: Asked,
  memo: WordMemo = new Map()
): string => {
  const parts = [...sentences.segment(text)].flatMap(({ segment }) =>
    piecesOf(segment.trim())
  );
  const every = exacts.map((_, index) => index);
  let best = parts[0] ?? text;
  let bestScore = -1;
  let bestExact = 0;
  for (const part of parts) {
    const words = wordsOf(part, memo);
    const exact =
      foundIn(sequenceOf(part), exacts, every).length +
      placesOfDates(part, dates).length;
    const score =
      exact * (terms.length + 1) +
      terms.filter((term) => holdsTerm(words, term)).length;
    if (score > bestScore) {
      best = part;
      bestScore = score;
      bestExact = exact;
    }
  }
  if (bestExact > 0) {
    return best;
  }
  const place = placeOfExact(text, exacts) ?? placesOfDates(text, dates)[0];
  return place === undefined ? best : windowOf(text, place[0], place[1]);
};

/** `found` as an item of the pack, given `text`. */
const itemOf = (
  { source, version, position, found: how }: Found,
  text: string,
  whole: boolean
): PackItem => ({ source, version, position, text, whole, found: how });

/**
 * `fused`, best first, fitted to `budget` tokens (contract.ts
 * `packItemTokens`): first each chunk's quote, best first, leaving out
 * one that no longer fits and going on with the next; then, with what is
 * left, each item widened to its whole chunk, best first. (A memory's
 * statement comes before its quote once memories are recalled, GRA-1745.)
 * Cut short when the budget left a chunk out or gave one only in part.
 */
export const packOf = (
  fused: readonly Found[],
  asked: Asked,
  budget: number,
  notFound: string[]
): Pack => {
  let left = budget;
  let truncated = false;
  const kept: { found: Found; item: PackItem }[] = [];
  // Each word is stemmed once for the whole pack, however many quotes
  // hold it.
  const memo: WordMemo = new Map();
  for (const found of fused) {
    // A quote is never empty, so an item costs at least its citation and
    // a token: one that can't fit is left out without choosing its quote.
    if (packItemTokens(itemOf(found, "", false)) + 1 > left) {
      truncated = true;
      continue;
    }
    const quote = quoteOf(found.text, asked, memo);
    const item = itemOf(found, quote, quote === found.text);
    const cost = packItemTokens(item);
    if (cost <= left) {
      left -= cost;
      kept.push({ found, item });
    } else {
      truncated = true;
    }
  }
  const items = kept.map(({ found, item }) => {
    if (item.whole) {
      return item;
    }
    const whole = itemOf(found, found.text, true);
    const more = packItemTokens(whole) - packItemTokens(item);
    if (more <= left) {
      left -= more;
      return whole;
    }
    truncated = true;
    return item;
  });
  return { items, notFound, truncated };
};
