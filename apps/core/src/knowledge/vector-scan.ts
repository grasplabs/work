/**
 * A vector shard's vectors in memory (vector-shard.ts): one float32 row
 * per record, searched exactly by scoring every row.
 */
import type { VectorMatch, VectorMetric } from "./vector-index.ts";

/**
 * How near a row is, higher nearer: cosine or dot product as they are,
 * euclidean as its negated distance. `sum` is the dot product, or for
 * euclidean the squared distance; a zero vector has cosine 0 to anything.
 */
const rankOf = (metric: VectorMetric, sum: number, norms: number): number => {
  if (metric === "euclidean") {
    return -Math.sqrt(sum);
  }
  if (metric === "cosine") {
    return norms === 0 ? 0 : sum / norms;
  }
  return sum;
};

/** The vectors of a shard in memory: one float32 row per record. */
export class Scan {
  readonly dimensions: number;
  #ids: string[] = [];
  readonly #slots = new Map<string, number>();
  #values: Float32Array;
  #norms: Float32Array;

  constructor(dimensions: number, capacity = 64) {
    this.dimensions = dimensions;
    this.#values = new Float32Array(capacity * dimensions);
    this.#norms = new Float32Array(capacity);
  }

  get size(): number {
    return this.#ids.length;
  }

  set(id: string, values: Float32Array): void {
    let slot = this.#slots.get(id);
    if (slot === undefined) {
      slot = this.#ids.length;
      this.#grow(slot + 1);
      this.#ids.push(id);
      this.#slots.set(id, slot);
    }
    this.#values.set(values, slot * this.dimensions);
    let squares = 0;
    for (const value of values) {
      squares += value * value;
    }
    this.#norms[slot] = Math.sqrt(squares);
  }

  /** Moves the last row into the removed one's place. */
  remove(id: string): void {
    const slot = this.#slots.get(id);
    if (slot === undefined) {
      return;
    }
    const last = this.#ids.length - 1;
    const lastId = this.#ids[last];
    if (slot !== last && lastId !== undefined) {
      const { dimensions } = this;
      this.#values.copyWithin(
        slot * dimensions,
        last * dimensions,
        (last + 1) * dimensions
      );
      this.#norms[slot] = this.#norms[last] ?? 0;
      this.#ids[slot] = lastId;
      this.#slots.set(lastId, slot);
    }
    this.#ids.pop();
    this.#slots.delete(id);
  }

  #grow(rows: number): void {
    if (rows <= this.#norms.length) {
      return;
    }
    const capacity = Math.max(rows, this.#norms.length * 2);
    const values = new Float32Array(capacity * this.dimensions);
    values.set(this.#values);
    const norms = new Float32Array(capacity);
    norms.set(this.#norms);
    this.#values = values;
    this.#norms = norms;
  }

  /**
   * The `topK` nearest rows: the highest cosine or dot product, or the
   * lowest euclidean distance, as `score`.
   */
  search(
    query: Float32Array,
    metric: VectorMetric,
    topK: number
  ): VectorMatch[] {
    const { dimensions } = this;
    const values = this.#values;
    const norms = this.#norms;
    let queryNorm = 0;
    for (const value of query) {
      queryNorm += value * value;
    }
    queryNorm = Math.sqrt(queryNorm);
    // The best rows so far, best first, by a rank where higher is nearer.
    const best: { slot: number; rank: number }[] = [];
    for (let slot = 0; slot < this.#ids.length; slot += 1) {
      const offset = slot * dimensions;
      let sum = 0;
      if (metric === "euclidean") {
        for (let n = 0; n < dimensions; n += 1) {
          const difference = (query[n] ?? 0) - (values[offset + n] ?? 0);
          sum += difference * difference;
        }
      } else {
        for (let n = 0; n < dimensions; n += 1) {
          sum += (query[n] ?? 0) * (values[offset + n] ?? 0);
        }
      }
      const rank = rankOf(metric, sum, queryNorm * (norms[slot] ?? 0));
      if (best.length === topK && rank <= (best.at(-1)?.rank ?? rank)) {
        continue;
      }
      let at = best.length;
      while (at > 0 && (best[at - 1]?.rank ?? rank) < rank) {
        at -= 1;
      }
      best.splice(at, 0, { slot, rank });
      if (best.length > topK) {
        best.pop();
      }
    }
    return best.map(({ slot, rank }) => ({
      id: this.#ids[slot] ?? "",
      score: metric === "euclidean" ? -rank : rank,
    }));
  }
}
