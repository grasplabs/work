// Orders that must agree wherever passages and memories are ranked: in
// one store's statements or its own cut of their lists, and in a merge of
// several stores' lists (across.ts).

/** What UTF-8 writes for a surrogate with no partner: U+FFFD. */
const replacement = 0xff_fd;

/** The code point of `text` at `index`, a lone surrogate as UTF-8 writes it. */
const codePointOf = (text: string, index: number): number => {
  const point = text.codePointAt(index) ?? 0;
  return point >= 0xd8_00 && point <= 0xdf_ff ? replacement : point;
};

/**
 * `a` and `b` as SQLite orders text (BINARY: by their UTF-8 bytes): by
 * code point, which is the same order, so nothing is encoded; a lone
 * surrogate counts as the U+FFFD UTF-8 writes for it. On every tie of
 * recall's orders, so it allocates nothing.
 */
export const byBytes = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  let left = 0;
  let right = 0;
  while (left < a.length && right < b.length) {
    const fromA = codePointOf(a, left);
    const fromB = codePointOf(b, right);
    if (fromA !== fromB) {
      return fromA - fromB;
    }
    left += fromA > 0xff_ff ? 2 : 1;
    right += fromB > 0xff_ff ? 2 : 1;
  }
  return Number(left < a.length) - Number(right < b.length);
};

/** A passage found by meaning, as both orders read it. */
export interface NearPassage {
  score: number;
  addedAt: number;
  source: string;
  position: number;
}

/**
 * The meaning way's order: nearer first; on a tie, the older version, then
 * by source and place. Of the passage alone, so one store ranks its own
 * and a merge ranks several stores' alike: the nearest of all are among
 * each store's nearest.
 */
export const byNearness = (a: NearPassage, b: NearPassage): number =>
  b.score - a.score ||
  a.addedAt - b.addedAt ||
  byBytes(a.source, b.source) ||
  a.position - b.position;

/**
 * A memory as recall orders it after a way's own score: whether the reader
 * may count a confirmation of it, whether it is the reader's own word (its
 * writer is the reader's person), when it was learned, when the reader
 * last used it (the request's `used`, or null), its id.
 */
export interface MemoryOrder {
  confirmed: boolean;
  own: boolean;
  learnedAt: number;
  usedAt: number | null;
  id: string;
}

/**
 * A memory's freshness for the reader: when it was learned, or when they
 * last used it if later. A memory nobody uses keeps the moment it was
 * learned while used ones move ahead: it fades, and is never dropped.
 */
const freshnessOf = ({ learnedAt, usedAt }: MemoryOrder): number =>
  Math.max(learnedAt, usedAt ?? learnedAt);

/**
 * Where a memory stands for the reader: their own word first, as a saved
 * memory is taken as correct, with no confirmation stored; level with a
 * confirmed one, it is the newer word of the person asking, so it comes
 * before it. Then a confirmed memory, then the rest.
 */
const standingOf = ({ own, confirmed }: MemoryOrder): number => {
  if (own) {
    return 0;
  }
  return confirmed ? 1 : 2;
};

/**
 * The one order of memories after a way's own score, wherever they are
 * cut or merged (recall-memories.ts, memories.ts `memoriesByWords`,
 * across.ts): the reader's own word, then confirmed (`standingOf`), so
 * neither ever fades below one that is neither; then fresher for the
 * reader; then newer; then by id, as SQLite orders text, the last first.
 */
export const byFreshness = (a: MemoryOrder, b: MemoryOrder): number =>
  standingOf(a) - standingOf(b) ||
  freshnessOf(b) - freshnessOf(a) ||
  b.learnedAt - a.learnedAt ||
  byBytes(b.id, a.id);

/** A memory the words way found, as it orders them: its counts first. */
export interface WordsOrder extends MemoryOrder {
  words: number;
  exact: number;
}

/**
 * The words way's order of memories: more of the question's telling words
 * first, then more of them as written, then `byFreshness`.
 */
export const byWordsFound = (a: WordsOrder, b: WordsOrder): number =>
  b.words - a.words || b.exact - a.exact || byFreshness(a, b);
