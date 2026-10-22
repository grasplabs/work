/**
 * One shard of the `sqlite` vector index (sqlite-vector-index.ts): a
 * SQLite Durable Object holding the vectors of one generation's records
 * under one read-policy key, or a sub-shard of a key with more records
 * than one shard holds. It knows nothing of policies: whoever reaches it
 * may search all of it, so only the provider, which picks shards by the
 * keys a caller holds, reaches it.
 *
 * A search is exact: it scores every vector the shard holds, from a copy
 * of them kept in memory as float32, loaded from SQLite on the first
 * search after the object wakes and kept current by every write. The
 * provider caps a shard (`shardCapacity`) so that copy stays far below an
 * isolate's 128 MB.
 *
 * Each write carries the catalog's sequence of the write it belongs to,
 * and a row keeps the highest it was written with, a removed one as a
 * tombstone: so a write that arrives after a later one changes nothing,
 * whatever order two writers' calls reach the shard in.
 *
 * Measured 2026-10-22 in workerd under `vp test`, on an Apple M5 Pro: one
 * key's records of 1024 random float32 dimensions, cosine, topK 10, 40
 * queries after the first. Locally every object shares one thread, so a
 * key's sub-shards are scanned one after another; on Cloudflare each is
 * an object of its own. Not yet measured on Cloudflare.
 *
 * | Vectors | Shards | First query | p50 | p95 | Writing all, 1000 a call |
 * | -- | -- | -- | -- | -- | -- |
 * | 10,000 | 1 | 109 ms | 9 ms | 13 ms | 1.5 s |
 * | 50,000 | 4 (16,384 each) | 426 ms | 38 ms | 40 ms | 7.4 s |
 */
import { DurableObject } from "cloudflare:workers";

import { migrateOnWake } from "../db/migrate.ts";
import migrations from "../db/vector-shard/migrations/migrations.js";
import type { VectorMatch, VectorMetric } from "./vector-index.ts";
import { Scan } from "./vector-scan.ts";

export class VectorShard extends DurableObject<Env> {
  /** The vectors in memory, from the first search after waking. */
  #scan: Scan | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateOnWake(ctx, migrations);
  }

  /**
   * Writes each record's vector, `dimensions` values each in order in
   * `values`, unless a later write already set it.
   */
  put(
    seq: number,
    ids: readonly string[],
    values: Float32Array,
    dimensions: number
  ): void {
    if (values.length !== ids.length * dimensions) {
      throw new Error("A vector shard write has a vector per record.");
    }
    const written = this.#write(seq, ids, (n) =>
      values.slice(n * dimensions, (n + 1) * dimensions)
    );
    for (const [id, vector] of written) {
      if (vector !== null) {
        this.#scanOf(dimensions)?.set(id, vector);
      }
    }
  }

  /** Removes each record's vector, unless a later write set it again. */
  remove(seq: number, ids: readonly string[]): void {
    const written = this.#write(seq, ids, () => null);
    for (const [id] of written) {
      this.#scan?.remove(id);
    }
  }

  /** The `topK` nearest vectors to `query`, nearest first. */
  search(
    query: Float32Array,
    metric: VectorMetric,
    topK: number
  ): VectorMatch[] {
    const scan = this.#scan ?? this.#load(query.length);
    if (scan.dimensions !== query.length) {
      throw new Error("A vector shard holds one generation's dimensions.");
    }
    return scan.search(query, metric, topK);
  }

  /** Removes everything the shard holds. */
  async clear(): Promise<void> {
    this.#scan = undefined;
    await this.ctx.storage.deleteAll();
    migrateOnWake(this.ctx, migrations);
  }

  /** The scan to keep current, if it is loaded. */
  #scanOf(dimensions: number): Scan | undefined {
    if (this.#scan !== undefined && this.#scan.dimensions !== dimensions) {
      this.#scan = undefined;
    }
    return this.#scan;
  }

  /**
   * Sets each row to `vectorOf` its place, or a tombstone for null, where
   * no write later than `seq` set it; returns the rows it set.
   */
  #write(
    seq: number,
    ids: readonly string[],
    vectorOf: (n: number) => Float32Array | null
  ): [string, Float32Array | null][] {
    const { sql } = this.ctx.storage;
    return this.ctx.storage.transactionSync(() =>
      ids.flatMap((id, n): [string, Float32Array | null][] => {
        const [row] = sql
          .exec<{ seq: number }>("SELECT seq FROM vectors WHERE id = ?", id)
          .toArray();
        if (row !== undefined && row.seq > seq) {
          return [];
        }
        const vector = vectorOf(n);
        sql.exec(
          "INSERT INTO vectors (id, seq, vec) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, vec = excluded.vec",
          id,
          seq,
          vector?.buffer ?? null
        );
        return [[id, vector]];
      })
    );
  }

  #load(dimensions: number): Scan {
    const rows = this.ctx.storage.sql.exec<{ id: string; vec: ArrayBuffer }>(
      "SELECT id, vec FROM vectors WHERE vec IS NOT NULL"
    );
    const scan = new Scan(dimensions);
    for (const { id, vec } of rows) {
      scan.set(id, new Float32Array(vec));
    }
    this.#scan = scan;
    return scan;
  }
}
