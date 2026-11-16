import { packItemTokens, packMemoryTokens } from "./contract.ts";
import type {
  FoundMemory,
  MemoryFoundBy,
  Pack,
  PackContested,
  PackItem,
  PackMemory,
} from "./contract.ts";
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
 * What a way's list holds: a passage, or a memory with the other sides
 * of its fact when contested (`rivals`, packed right after it). `key` is
 * the same for the same passage or memory in any list.
 */
export type Entry =
  | { kind: "passage"; key: string; passage: Found }
  | {
      kind: "memory";
      key: string;
      memory: FoundMemory;
      found: MemoryFoundBy;
      rivals: readonly { key: string; memory: FoundMemory }[];
    };

/**
 * Reciprocal rank fusion's constant: a list's first result scores 1/61,
 * its tenth 1/70. The usual value (Cormack, Clarke and Büttcher, 2009),
 * kept: the evaluation showed no reason to move it.
 */
const fusionK = 60;

/**
 * `lists`, each best first, as one list by reciprocal rank fusion: an
 * entry scores the sum of 1 / (60 + its rank) over the lists that hold
 * it, so one found high by any way comes near the top, and one found by
 * several ways above one found by one. Ties go to the entry with the
 * better rank in a list, then to the list given first. An entry in
 * several lists keeps how the first list given found it. Only ranks
 * count, never a list's own scores (a cosine and a count of words don't
 * compare), so vectors are one more list, given last: a chunk found by
 * meaning alone says so. Passages and memories are fused alike.
 */
export const fuse = (lists: readonly (readonly Entry[])[]): Entry[] => {
  const scored = new Map<
    string,
    { entry: Entry; score: number; best: number; list: number }
  >();
  for (const [list, ranked] of lists.entries()) {
    for (const [index, entry] of ranked.entries()) {
      const rank = index + 1;
      const known = scored.get(entry.key);
      if (known === undefined) {
        scored.set(entry.key, {
          entry,
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
    .map(({ entry }) => entry);
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
 * found by. A chunk found by meaning alone may hold none of the question's
 * words: then every part ties and the quote is its first sentence, its
 * opening, the one part that claims nothing about which sentence carries
 * the meaning (the store has a vector of the chunk only, never of its
 * sentences).
 */
export const quoteOf = (
  text: string,
  { terms, exacts }: Asked,
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
    const exact = foundIn(sequenceOf(part), exacts, every).length;
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
  const place = placeOfExact(text, exacts);
  return place === undefined ? best : windowOf(text, place[0], place[1]);
};

/** `found` as an item of the pack, given `text`. */
const itemOf = (
  { source, version, position, found: how }: Found,
  text: string,
  whole: boolean
): PackItem => ({ source, version, position, text, whole, found: how });

/** `memory` as a memory of the pack, its statement alone. */
const memoryItemOf = (
  memory: FoundMemory,
  found: MemoryFoundBy
): PackMemory => ({
  memory: memory.id,
  about: memory.about,
  attribute: memory.attribute,
  object: memory.object,
  type: memory.type,
  statement: memory.statement,
  quote: null,
  context: null,
  source: memory.source,
  writer: memory.writer,
  speaker: memory.speaker,
  validFrom: memory.validFrom,
  validUntil: memory.validUntil,
  learnedAt: memory.learnedAt,
  contested: memory.contested,
  confirmed: memory.confirmed !== null,
  found,
});

/** What the pack holds of an entry so far. */
type Held =
  | { kind: "passage"; found: Found; item: PackItem }
  | { kind: "memory"; found: FoundMemory; item: PackMemory };

/**
 * The contested facts among `memories`: each entity's attribute for
 * which the pack holds more than one side, in the order of its first.
 */
const contestedOf = (packed: readonly PackMemory[]): PackContested[] => {
  const facts = new Map<string, PackContested>();
  for (const { memory, about, attribute, contested } of packed) {
    if (!contested || attribute === null) {
      continue;
    }
    const key = JSON.stringify([about, attribute]);
    const fact = facts.get(key) ?? { about, attribute, memories: [] };
    fact.memories.push(memory);
    facts.set(key, fact);
  }
  return [...facts.values()].filter(({ memories }) => memories.length > 1);
};

/**
 * `fused`, best first, fitted to `budget` tokens (contract.ts
 * `packItemTokens`, `packMemoryTokens`), in three passes, each best first,
 * leaving out what no longer fits and going on with the next: first each
 * passage's quote and each memory's statement (a contested memory's other
 * sides right after it, all of them or none: `contested` lists only facts
 * whose every side is packed); then each passage widened to its whole chunk and
 * each memory's quote; then each memory's passage around its quote. Cut
 * short when the budget left anything out.
 */
export const packOf = (
  fused: readonly Entry[],
  asked: Asked,
  budget: number,
  notFound: string[]
): Pack => {
  let left = budget;
  let truncated = false;
  const held: Held[] = [];
  const placed = new Set<string>();
  // Each word is stemmed once for the whole pack, however many quotes
  // hold it.
  const memo: WordMemo = new Map();
  // A memory with the other sides of its contested fact, held or left
  // out together: a contested fact is packed with every side the reader
  // may read, or with none, and nothing of a group left out takes room.
  // A side left out once (its group didn't fit) keeps the rest of its
  // fact out too.
  const skipped = new Set<string>();
  const holdGroup = (
    group: readonly { key: string; memory: FoundMemory; found: MemoryFoundBy }[]
  ): void => {
    const fresh = group.filter(({ key }) => !placed.has(key));
    for (const { key } of fresh) {
      placed.add(key);
    }
    if (fresh.length === 0) {
      return;
    }
    const items = fresh.map(({ memory, found }) => ({
      memory,
      item: memoryItemOf(memory, found),
    }));
    const cost = items.reduce(
      (sum, { item }) => sum + packMemoryTokens(item),
      0
    );
    if (group.some(({ key }) => skipped.has(key)) || cost > left) {
      truncated = true;
      for (const { key } of fresh) {
        skipped.add(key);
      }
      return;
    }
    left -= cost;
    for (const { memory, item } of items) {
      held.push({ kind: "memory", found: memory, item });
    }
  };
  for (const entry of fused) {
    if (entry.kind === "memory") {
      holdGroup([
        { key: entry.key, memory: entry.memory, found: entry.found },
        ...entry.rivals.map((rival) => ({
          key: rival.key,
          memory: rival.memory,
          found: "contested" as const,
        })),
      ]);
      continue;
    }
    const found = entry.passage;
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
      held.push({ kind: "passage", found, item });
    } else {
      truncated = true;
    }
  }
  // Then more of each, in two passes: what a memory says it rests on comes
  // before the passage around it.
  const fits = (more: number): boolean => {
    if (more <= left) {
      left -= more;
      return true;
    }
    truncated = true;
    return false;
  };
  for (const hold of held) {
    if (hold.kind === "passage") {
      const whole = itemOf(hold.found, hold.found.text, true);
      if (
        !hold.item.whole &&
        fits(packItemTokens(whole) - packItemTokens(hold.item))
      ) {
        hold.item = whole;
      }
    } else if (hold.found.quote !== null) {
      const quoted = { ...hold.item, quote: hold.found.quote };
      if (fits(packMemoryTokens(quoted) - packMemoryTokens(hold.item))) {
        hold.item = quoted;
      }
    }
  }
  for (const hold of held) {
    if (
      hold.kind === "memory" &&
      hold.found.context !== null &&
      hold.item.quote !== null
    ) {
      const around = { ...hold.item, context: hold.found.context };
      if (fits(packMemoryTokens(around) - packMemoryTokens(hold.item))) {
        hold.item = around;
      }
    }
  }
  const items = held.flatMap((hold) =>
    hold.kind === "passage" ? [hold.item] : []
  );
  const memories = held.flatMap((hold) =>
    hold.kind === "memory" ? [hold.item] : []
  );
  return {
    items,
    memories,
    contested: contestedOf(memories),
    notFound,
    truncated,
  };
};
