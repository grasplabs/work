import { packItemTokens } from "./contract.ts";
import type { Pack, PackItem } from "./contract.ts";
import { foundIn } from "./exact.ts";
import type { Exact } from "./exact.ts";
import { holdsTerm, wordsOf } from "./words.ts";
import type { Word } from "./words.ts";

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

/** What a quote is chosen for: the question's telling words and exact parts. */
export interface Asked {
  terms: readonly Word[];
  exacts: readonly Exact[];
}

/**
 * The part of `text` that best answers `asked`: its sentence (or, for a
 * sentence over `quoteMaxLength`, its piece) holding the most of the
 * question's exact parts, then the most of its telling words in any form;
 * the first on a tie. The text itself when it is one such part.
 */
export const quoteOf = (text: string, { terms, exacts }: Asked): string => {
  const parts = [...sentences.segment(text)].flatMap(({ segment }) =>
    piecesOf(segment.trim())
  );
  const every = exacts.map((_, index) => index);
  let best = parts[0] ?? text;
  let bestScore = -1;
  for (const part of parts) {
    const words = wordsOf(part);
    const score =
      foundIn(part, exacts, every).length * (terms.length + 1) +
      terms.filter((term) => holdsTerm(words, term)).length;
    if (score > bestScore) {
      best = part;
      bestScore = score;
    }
  }
  return best;
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
  for (const found of fused) {
    const quote = quoteOf(found.text, asked);
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
