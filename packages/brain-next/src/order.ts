// Orders that must agree wherever passages are ranked: in one store's
// statements and in a merge of several stores' lists (across.ts).

const encoder = new TextEncoder();

/** `a` and `b` as SQLite orders text (BINARY: by their UTF-8 bytes). */
export const byBytes = (a: string, b: string): number => {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const shorter = Math.min(left.length, right.length);
  for (let index = 0; index < shorter; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
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
