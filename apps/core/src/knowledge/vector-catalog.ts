/**
 * The catalog of the `sqlite` vector index (sqlite-vector-index.ts): one
 * SQLite Durable Object per deployment that knows the index's generations
 * and, for every record of each, which shard holds its vector. It holds no
 * vectors. Every call of the index starts here, so a generation that was
 * never created, or is being dropped, is refused before any shard is
 * reached.
 *
 * A write goes through it in steps that the provider runs in order:
 * `plan` places the records and marks them pending, the shards apply the
 * write, then `commit` records the source versions. So a write that fails
 * part way leaves its records pending, and `ids` lists a pending record
 * as damaged, with no source version: reconciling the index (vector-rebuild.ts) finds
 * it stale or extra, whichever its canonical record says, and writes or
 * deletes it again. A record that moved to another policy key keeps a
 * `moving` row for its old shard until its vector there is gone, so a
 * write repeated after a failure removes it, never leaving it findable
 * under a key it no longer has.
 */
import { DurableObject } from "cloudflare:workers";
import { and, asc, count, eq, gt, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import { migrateOnWake } from "../db/migrate.ts";
import migrations from "../db/vector-catalog/migrations/migrations.js";
import { entries, generations, moving } from "../db/vector-catalog/schema.ts";
import type { VectorGeneration } from "./vector-index.ts";

/** A record's place: the shard of its policy key that holds its vector. */
export interface Placement {
  id: string;
  policy: string;
  shard: number;
}

/** One shard: a policy key's sub-shard. */
export interface ShardRef {
  policy: string;
  shard: number;
}

/** Why the catalog didn't answer: the provider fails `invalid` with it. */
export interface Refusal {
  refused: string;
}

/** What the catalog answers, or why it didn't. */
export type Answer<Value> = { answer: Value } | Refusal;

export interface WritePlan {
  /** The write's sequence: every shard write of it carries this. */
  seq: number;
  placements: Placement[];
  /** Old places of the records to remove before writing the new ones. */
  moves: Placement[];
}

export interface DeletePlan {
  seq: number;
  /** Every place a vector of the records may be in. */
  placements: Placement[];
}

export interface CatalogEntry {
  id: string;
  /** Null while a write or delete of it isn't done. */
  version: string | null;
}

/** SQLite takes at most 100 bound parameters a statement. */
const inChunk = 90;

const chunked = <Item>(items: readonly Item[], size: number): Item[][] => {
  const chunks: Item[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
};

const generationSchema = z.object({
  id: z.string(),
  model: z.string(),
  revision: z.string(),
  route: z.string(),
  dimensions: z.number(),
  metric: z.enum(["cosine", "euclidean", "dot-product"]),
});

/** A generation as stored and compared: its fields in one order. */
const specOf = ({
  id,
  model,
  revision,
  route,
  dimensions,
  metric,
}: VectorGeneration): string =>
  JSON.stringify({ id, model, revision, route, dimensions, metric });

export class VectorCatalog extends DurableObject<Env> {
  readonly #db = drizzle(this.ctx.storage);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateOnWake(ctx, migrations);
  }

  /** Adds the generation, unless it is there. */
  create(generation: VectorGeneration): Answer<{ vectors: number }> {
    const found = this.#db
      .select()
      .from(generations)
      .where(eq(generations.id, generation.id))
      .get();
    if (found?.state === "dropping") {
      return {
        refused: `Generation ${generation.id} is being dropped: drop it again before creating it.`,
      };
    }
    if (found === undefined) {
      this.#db
        .insert(generations)
        .values({ id: generation.id, spec: specOf(generation), state: "ready" })
        .run();
    }
    return this.status(generation);
  }

  /** The generations created and not dropped. */
  generations(): VectorGeneration[] {
    return this.#db
      .select({ spec: generations.spec })
      .from(generations)
      .where(eq(generations.state, "ready"))
      .all()
      .map(({ spec }) => generationSchema.parse(JSON.parse(spec)));
  }

  status(generation: VectorGeneration): Answer<{ vectors: number }> {
    const refusal = this.#refusal(generation);
    if (refusal !== undefined) {
      return refusal;
    }
    const [row] = this.#db
      .select({ vectors: count() })
      .from(entries)
      .where(eq(entries.generation, generation.id))
      .all();
    return { answer: { vectors: row?.vectors ?? 0 } };
  }

  /**
   * Places each record in a shard of its policy key, its own if it has
   * one there, else the first with room under `capacity`, and marks it
   * pending under a new sequence.
   */
  plan(
    generation: VectorGeneration,
    records: readonly { id: string; policy: string }[],
    capacity: number
  ): Answer<WritePlan> {
    const refusal = this.#refusal(generation);
    if (refusal !== undefined) {
      return refusal;
    }
    const plan = this.ctx.storage.transactionSync((): WritePlan => {
      const seq = this.#nextSeq(generation.id);
      const sizes = new Map<string, Map<number, number>>();
      const sizesOf = (policy: string): Map<number, number> => {
        let found = sizes.get(policy);
        if (found === undefined) {
          found = new Map(
            this.#db
              .select({ shard: entries.shard, size: count() })
              .from(entries)
              .where(
                and(
                  eq(entries.generation, generation.id),
                  eq(entries.policy, policy)
                )
              )
              .groupBy(entries.shard)
              .all()
              .map(({ shard, size }) => [shard, size])
          );
          sizes.set(policy, found);
        }
        return found;
      };
      const placements = records.map(({ id, policy }): Placement => {
        const current = this.#entry(generation.id, id);
        if (current?.policy === policy) {
          this.#place(generation.id, { id, policy, shard: current.shard }, seq);
          return { id, policy, shard: current.shard };
        }
        if (current !== undefined) {
          this.#db
            .insert(moving)
            .values({
              generation: generation.id,
              id,
              policy: current.policy,
              shard: current.shard,
            })
            .onConflictDoNothing()
            .run();
          const old = sizesOf(current.policy);
          old.set(current.shard, (old.get(current.shard) ?? 1) - 1);
        }
        const shardSizes = sizesOf(policy);
        let shard = 0;
        while ((shardSizes.get(shard) ?? 0) >= capacity) {
          shard += 1;
        }
        shardSizes.set(shard, (shardSizes.get(shard) ?? 0) + 1);
        this.#place(generation.id, { id, policy, shard }, seq);
        return { id, policy, shard };
      });
      return {
        seq,
        placements,
        moves: this.#movesOf(
          generation.id,
          records.map(({ id }) => id)
        ),
      };
    });
    return { answer: plan };
  }

  /** Forgets old places whose vectors are gone. */
  settle(generation: string, moves: readonly Placement[]): void {
    this.ctx.storage.transactionSync(() => {
      this.#settle(generation, moves);
    });
  }

  /**
   * Records each written record's source version, where no later write
   * placed it since.
   */
  commit(
    generation: string,
    seq: number,
    written: readonly { id: string; version: string }[]
  ): void {
    this.ctx.storage.transactionSync(() => {
      for (const { id, version } of written) {
        this.#db
          .update(entries)
          .set({ version, pending: 0 })
          .where(
            and(
              eq(entries.generation, generation),
              eq(entries.id, id),
              eq(entries.seq, seq)
            )
          )
          .run();
      }
    });
  }

  /**
   * Marks the records pending under a new sequence, and says every place
   * their vectors may be in.
   */
  planDelete(
    generation: VectorGeneration,
    ids: readonly string[]
  ): Answer<DeletePlan> {
    const refusal = this.#refusal(generation);
    if (refusal !== undefined) {
      return refusal;
    }
    const plan = this.ctx.storage.transactionSync((): DeletePlan => {
      const seq = this.#nextSeq(generation.id);
      const placements: Placement[] = [];
      for (const id of ids) {
        const current = this.#entry(generation.id, id);
        if (current !== undefined) {
          this.#place(generation.id, current, seq);
          placements.push(current);
        }
      }
      placements.push(...this.#movesOf(generation.id, ids));
      return { seq, placements };
    });
    return { answer: plan };
  }

  /**
   * Forgets deleted records, where no later write placed them since, and
   * the old places their vectors were removed from.
   */
  forget(
    generation: string,
    seq: number,
    ids: readonly string[],
    removed: readonly Placement[]
  ): void {
    this.ctx.storage.transactionSync(() => {
      for (const id of ids) {
        this.#db
          .delete(entries)
          .where(
            and(
              eq(entries.generation, generation),
              eq(entries.id, id),
              eq(entries.seq, seq)
            )
          )
          .run();
      }
      this.#settle(generation, removed);
    });
  }

  /**
   * The shards holding records under the given keys, in the keys' order,
   * each key's sub-shards in theirs.
   */
  shards(
    generation: VectorGeneration,
    policies: readonly string[]
  ): Answer<ShardRef[]> {
    const refusal = this.#refusal(generation);
    if (refusal !== undefined) {
      return refusal;
    }
    const byPolicy = new Map<string, number[]>();
    for (const chunk of chunked(policies, inChunk)) {
      const rows = this.#db
        .selectDistinct({ policy: entries.policy, shard: entries.shard })
        .from(entries)
        .where(
          and(
            eq(entries.generation, generation.id),
            inArray(entries.policy, chunk)
          )
        )
        .orderBy(asc(entries.shard))
        .all();
      for (const { policy, shard } of rows) {
        byPolicy.set(policy, [...(byPolicy.get(policy) ?? []), shard]);
      }
    }
    return {
      answer: policies.flatMap((policy) =>
        (byPolicy.get(policy) ?? []).map((shard) => ({ policy, shard }))
      ),
    };
  }

  /** Up to `limit` records after `after`, by ID. */
  ids(
    generation: VectorGeneration,
    after: string | undefined,
    limit: number
  ): Answer<CatalogEntry[]> {
    const refusal = this.#refusal(generation);
    if (refusal !== undefined) {
      return refusal;
    }
    const listed = this.#db
      .select({
        id: entries.id,
        version: sql<
          string | null
        >`CASE WHEN ${entries.pending} = 0 THEN ${entries.version} END`,
      })
      .from(entries)
      .where(
        and(
          eq(entries.generation, generation.id),
          after === undefined ? undefined : gt(entries.id, after)
        )
      )
      .orderBy(asc(entries.id))
      .limit(limit)
      .all();
    return { answer: listed };
  }

  /**
   * Starts dropping the generation: from now on nothing reads or writes
   * it. Says every shard to empty; none for a generation it doesn't have.
   */
  dropBegin(generation: VectorGeneration): ShardRef[] {
    const found = this.#db
      .select()
      .from(generations)
      .where(eq(generations.id, generation.id))
      .get();
    if (found === undefined) {
      return [];
    }
    this.#db
      .update(generations)
      .set({ state: "dropping" })
      .where(eq(generations.id, generation.id))
      .run();
    const refs = [
      ...this.#db
        .selectDistinct({ policy: entries.policy, shard: entries.shard })
        .from(entries)
        .where(eq(entries.generation, generation.id))
        .all(),
      ...this.#db
        .selectDistinct({ policy: moving.policy, shard: moving.shard })
        .from(moving)
        .where(eq(moving.generation, generation.id))
        .all(),
    ];
    return [
      ...new Map(
        refs.map((ref) => [JSON.stringify([ref.policy, ref.shard]), ref])
      ).values(),
    ];
  }

  /** Forgets the generation, once its shards are empty. */
  dropEnd(generation: string): void {
    this.ctx.storage.transactionSync(() => {
      this.#db.delete(entries).where(eq(entries.generation, generation)).run();
      this.#db.delete(moving).where(eq(moving.generation, generation)).run();
      this.#db.delete(generations).where(eq(generations.id, generation)).run();
    });
  }

  /** Why the generation can't be used now, if it can't. */
  #refusal(generation: VectorGeneration): Refusal | undefined {
    const found = this.#db
      .select()
      .from(generations)
      .where(eq(generations.id, generation.id))
      .get();
    if (found === undefined || found.state !== "ready") {
      return {
        refused: `The vector index has no generation ${generation.id}: create it first.`,
      };
    }
    if (found.spec !== specOf(generation)) {
      return {
        refused: `Generation ${generation.id} was created with another model, revision, route, dimensions or metric.`,
      };
    }
    return undefined;
  }

  #nextSeq(generation: string): number {
    const [row] = this.#db
      .update(generations)
      .set({ seq: sql`${generations.seq} + 1` })
      .where(eq(generations.id, generation))
      .returning({ seq: generations.seq })
      .all();
    if (row === undefined) {
      throw new Error(`No vector generation ${generation}.`);
    }
    return row.seq;
  }

  #entry(generation: string, id: string): Placement | undefined {
    return this.#db
      .select({ id: entries.id, policy: entries.policy, shard: entries.shard })
      .from(entries)
      .where(and(eq(entries.generation, generation), eq(entries.id, id)))
      .get();
  }

  /** Sets a record's place, pending under `seq`. */
  #place(generation: string, { id, policy, shard }: Placement, seq: number) {
    this.#db
      .insert(entries)
      .values({ generation, id, policy, shard, seq, version: null, pending: 1 })
      .onConflictDoUpdate({
        target: [entries.generation, entries.id],
        set: { policy, shard, seq, pending: 1 },
      })
      .run();
  }

  #settle(generation: string, moves: readonly Placement[]): void {
    for (const { id, policy, shard } of moves) {
      this.#db
        .delete(moving)
        .where(
          and(
            eq(moving.generation, generation),
            eq(moving.id, id),
            eq(moving.policy, policy),
            eq(moving.shard, shard)
          )
        )
        .run();
    }
  }

  #movesOf(generation: string, ids: readonly string[]): Placement[] {
    return chunked(ids, inChunk).flatMap((chunk) =>
      this.#db
        .select({ id: moving.id, policy: moving.policy, shard: moving.shard })
        .from(moving)
        .where(
          and(eq(moving.generation, generation), inArray(moving.id, chunk))
        )
        .all()
    );
  }
}
