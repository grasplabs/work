// How a recall puts its lanes' candidates together (GRA-304, the Brain
// design's "Retrieval"): reciprocal rank fusion, under a versioned
// policy. Each lane ranks only what its reader may read; a candidate is
// one source at one version, found by any lane, scored by the ranks each
// lane gave it, never by a lane's own score (a BM25 or cosine number says
// nothing of whether evidence is true, and lanes' scores aren't
// comparable). Pure.

/** A recall's lanes: exact identifiers and phrases, the question's words, and vectors. */
export type Lane = "exact" | "fulltext" | "semantic";

/**
 * The fusion policy, its version a pack's `retrievalPolicyVersion`: RRF's
 * `k`, and how much each lane's ranks count. An exact match counts twice:
 * what a question names exactly comes before what merely shares its words.
 */
export const fusionPolicy = {
  version: "hybrid@1",
  k: 60,
  weights: { exact: 2, fulltext: 1, semantic: 1 },
} as const satisfies {
  version: string;
  k: number;
  weights: Record<Lane, number>;
};

/** One lane's candidates, best first, each by the source version it is. */
export interface LaneRanking<T> {
  lane: Lane;
  candidates: readonly { key: string; value: T }[];
}

/** A fused candidate: the lanes that found it, and its fused score. */
export interface Fused<T> {
  key: string;
  value: T;
  lanes: Lane[];
  score: number;
}

/**
 * `rankings` fused: each source version once, with the first value a lane
 * gave for it, best first by its summed reciprocal ranks; ties in the
 * order the candidates were first met (lanes in order, best first), so the
 * same reads fuse the same.
 */
export const fused = <T>(rankings: readonly LaneRanking<T>[]): Fused<T>[] => {
  const byKey = new Map<string, Fused<T> & { first: number }>();
  let met = 0;
  for (const { lane, candidates } of rankings) {
    for (const [index, { key, value }] of candidates.entries()) {
      const weight = fusionPolicy.weights[lane] / (fusionPolicy.k + index + 1);
      const known = byKey.get(key);
      if (known === undefined) {
        byKey.set(key, {
          key,
          value,
          lanes: [lane],
          score: weight,
          first: met,
        });
        met += 1;
      } else {
        known.score += weight;
        if (!known.lanes.includes(lane)) {
          known.lanes.push(lane);
        }
      }
    }
  }
  return [...byKey.values()]
    .toSorted(
      (one, other) => other.score - one.score || one.first - other.first
    )
    .map(({ key, value, lanes, score }) => ({ key, value, lanes, score }));
};
