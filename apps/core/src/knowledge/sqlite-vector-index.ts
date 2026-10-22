/**
 * The `sqlite` profile of the vector index (vector-index.ts): SQLite
 * Durable Objects, the same code in both deployment profiles. On
 * Cloudflare every object is created through `jurisdiction("eu")`, so the
 * index runs and stores its vectors only in the EU; on plain workerd
 * (on-prem, tests) `DURABLE_OBJECT_JURISDICTION=none` (durable-objects.ts).
 *
 * - One catalog per deployment (vector-catalog.ts) knows the generations
 *   and which shard holds each record.
 * - One shard (vector-shard.ts) per generation, read-policy key and
 *   sub-shard holds the vectors. A key gets another sub-shard once its
 *   shards are full ({@link shardCapacity}).
 *
 * The policy filter is exact by construction: a search reaches only the
 * shards of the keys the caller holds, so no filter can be truncated,
 * collide or be left out, and no sentinel needs to prove it. It searches
 * the keys {@link policyBatches} covers, as every profile does, so
 * `complete` means the same everywhere, and every shard of them, in
 * parallel, at most {@link maxShardsPerSearch}: past those it is
 * incomplete too. Each shard scans all its vectors exactly; no HNSW.
 *
 * Writes and deletes are synchronous: once one resolves, every search and
 * listing sees it. Matches are candidates all the same: callers recheck
 * current grants, as on every profile.
 */
import { inJurisdiction } from "../durable-objects.ts";
import type {
  Answer,
  Placement,
  ShardRef,
  VectorCatalog,
} from "./vector-catalog.ts";
import {
  checkGeneration,
  checkIds,
  checkQuery,
  checkRecords,
  fromProvider,
  maxDimensions,
  mergeNearest,
  VectorIndexError,
} from "./vector-index.ts";
import type {
  VectorGeneration,
  VectorIdPage,
  VectorIndex,
  VectorIndexProvider,
  VectorIndexStatus,
  VectorRecord,
} from "./vector-index.ts";
import type { VectorShard } from "./vector-shard.ts";

/** The objects the provider reaches: a namespace each, or a stand-in. */
export interface SqliteVectorStores {
  catalog: Pick<DurableObjectNamespace<VectorCatalog>, "getByName">;
  shards: Pick<DurableObjectNamespace<VectorShard>, "getByName">;
}

export interface SqliteVectorOptions {
  /**
   * The catalog's name, and so the index's: one per deployment, so the
   * default unless a test keeps its own apart.
   */
  name?: string;
  /** Defaults to 5 s. */
  queryDeadlineMs?: number;
  /** Per write step; defaults to 15 s. */
  writeDeadlineMs?: number;
  /**
   * Records a shard holds, if fewer than {@link shardCapacity}: so a test
   * reaches sub-shards without filling one.
   */
  shardCapacity?: number;
}

/**
 * The float32 bytes a shard holds in memory at most: half an isolate's
 * 128 MB, so a search's own work and the rest of the object fit beside it.
 */
const shardBytes = 64 * 1024 * 1024;

/** Records a shard holds at most, whatever their dimensions. */
const maxShardRecords = 50_000;

/**
 * Records one shard of a generation holds: 16,384 at 1024 dimensions,
 * 10,922 at the most, 1536.
 */
export const shardCapacity = (dimensions: number): number =>
  Math.min(maxShardRecords, Math.floor(shardBytes / (dimensions * 4)));

/**
 * Shards one search reaches before it reports itself incomplete: as many
 * as the keys {@link policyBatches} covers at most, so only keys with
 * sub-shards can reach it.
 */
export const maxShardsPerSearch = 400;

/** Shards a search or a drop calls at once. */
const shardConcurrency = 32;

/** Records each write step places, writes and commits together. */
const writeStep = 500;

/** Records one shard call carries at most: under 3 MB at 1536 dimensions. */
const shardCallRecords = 500;

const idPage = 1000;
const queryDeadlineMs = 5000;
const writeDeadlineMs = 15_000;
const defaultName = "vector-index";

// The shard capacity at the largest dimensions still holds a write step.
if (shardCapacity(maxDimensions) < writeStep) {
  throw new Error("A vector shard must hold at least one write step.");
}

const inSteps = <Item>(items: readonly Item[], size: number): Item[][] => {
  const steps: Item[][] = [];
  for (let start = 0; start < items.length; start += size) {
    steps.push(items.slice(start, start + size));
  }
  return steps;
};

/** `call` on every item, at most `limit` at once, in the items' order. */
const eachLimited = async <Item, Result>(
  items: readonly Item[],
  limit: number,
  call: (item: Item) => Promise<Result>
): Promise<Result[]> => {
  const results: Result[] = [];
  // One iterator shared by every worker: each item goes to one of them.
  const queue = items.entries();
  const worker = async (): Promise<void> => {
    for (const [at, item] of queue) {
      // oxlint-disable-next-line no-await-in-loop -- each worker calls one at a time
      results[at] = await call(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
};

/** The catalog's answer, or `invalid` for its refusal. */
const answerOf = <Value>(answer: Answer<Value>): Value => {
  if ("refused" in answer) {
    throw new VectorIndexError("invalid", answer.refused);
  }
  return answer.answer;
};

/** Places grouped by shard, in the order each shard first comes. */
const byShard = <Place extends ShardRef>(
  places: readonly Place[]
): { ref: ShardRef; places: Place[] }[] => {
  const groups = new Map<string, { ref: ShardRef; places: Place[] }>();
  for (const place of places) {
    const key = JSON.stringify([place.policy, place.shard]);
    const group = groups.get(key) ?? {
      ref: { policy: place.policy, shard: place.shard },
      places: [],
    };
    group.places.push(place);
    groups.set(key, group);
  }
  return [...groups.values()];
};

/**
 * The `sqlite` provider over `stores`. Each call starts at the catalog,
 * which refuses a generation it doesn't have.
 */
export const sqliteVectorIndexProvider = (
  stores: SqliteVectorStores,
  options: SqliteVectorOptions = {}
): VectorIndexProvider => {
  const name = options.name ?? defaultName;
  const queryDeadline = options.queryDeadlineMs ?? queryDeadlineMs;
  const writeDeadline = options.writeDeadlineMs ?? writeDeadlineMs;
  const catalog = () => stores.catalog.getByName(name);
  const shardOf = (generation: VectorGeneration, { policy, shard }: ShardRef) =>
    stores.shards.getByName(
      JSON.stringify([name, generation.id, policy, shard])
    );

  /** Removes the vectors at `places`, as of write `seq`. */
  const removeAt = async (
    generation: VectorGeneration,
    seq: number,
    places: readonly Placement[]
  ): Promise<void> => {
    await Promise.all(
      byShard(places).map(async ({ ref, places: of }) => {
        for (const step of inSteps(of, shardCallRecords)) {
          // oxlint-disable-next-line no-await-in-loop -- one call at a time per shard
          await shardOf(generation, ref).remove(
            seq,
            step.map(({ id }) => id)
          );
        }
      })
    );
  };

  const putAt = async (
    generation: VectorGeneration,
    seq: number,
    places: readonly Placement[],
    records: ReadonlyMap<string, VectorRecord>
  ): Promise<void> => {
    const { dimensions } = generation;
    await Promise.all(
      byShard(places).map(async ({ ref, places: of }) => {
        for (const step of inSteps(of, shardCallRecords)) {
          const values = new Float32Array(step.length * dimensions);
          for (const [n, { id }] of step.entries()) {
            values.set(records.get(id)?.values ?? [], n * dimensions);
          }
          // oxlint-disable-next-line no-await-in-loop -- one call at a time per shard
          await shardOf(generation, ref).put(
            seq,
            step.map(({ id }) => id),
            values,
            dimensions
          );
        }
      })
    );
  };

  const indexOf = (generation: VectorGeneration): VectorIndex => {
    checkGeneration(generation);

    const query: VectorIndex["query"] = async (vector, search) => {
      const { batches, complete } = checkQuery(generation, vector, search);
      if (batches.length === 0) {
        return { matches: [], complete };
      }
      return await fromProvider("search", queryDeadline, async () => {
        const shards = answerOf(
          await catalog().shards(generation, batches.flat())
        );
        const searched = shards.slice(0, maxShardsPerSearch);
        const target = Float32Array.from(vector);
        const answers = await eachLimited(
          searched,
          shardConcurrency,
          async (ref) =>
            await shardOf(generation, ref).search(
              target,
              generation.metric,
              search.topK
            )
        );
        return {
          matches: mergeNearest(answers, generation.metric, search.topK),
          complete: complete && searched.length === shards.length,
        };
      });
    };

    const upsert = async (records: readonly VectorRecord[]): Promise<void> => {
      const latest = checkRecords(generation, records);
      const capacity = Math.min(
        shardCapacity(generation.dimensions),
        options.shardCapacity ?? Number.POSITIVE_INFINITY
      );
      for (const step of inSteps(latest, writeStep)) {
        // oxlint-disable-next-line no-await-in-loop -- one step at a time, so a failure leaves the later ones unwritten
        await fromProvider("save vectors", writeDeadline, async () => {
          const plan = answerOf(
            await catalog().plan(
              generation,
              step.map(({ id, policy }) => ({ id, policy })),
              capacity
            )
          );
          // The old places first: a record is never findable under a key
          // it was moved from once its new place is written.
          await removeAt(generation, plan.seq, plan.moves);
          await catalog().settle(generation.id, plan.moves);
          await putAt(
            generation,
            plan.seq,
            plan.placements,
            new Map(step.map((record) => [record.id, record]))
          );
          await catalog().commit(
            generation.id,
            plan.seq,
            step.map(({ id, sourceVersion }) => ({
              id,
              version: sourceVersion,
            }))
          );
        });
      }
    };

    const remove = async (ids: readonly string[]): Promise<void> => {
      for (const step of inSteps(checkIds(ids), writeStep)) {
        // oxlint-disable-next-line no-await-in-loop -- one step at a time, as writes go
        await fromProvider("delete vectors", writeDeadline, async () => {
          const plan = answerOf(await catalog().planDelete(generation, step));
          await removeAt(generation, plan.seq, plan.placements);
          await catalog().forget(
            generation.id,
            plan.seq,
            step,
            plan.placements
          );
        });
      }
    };

    const ids = async (cursor?: string): Promise<VectorIdPage> =>
      await fromProvider("list vectors", queryDeadline, async () => {
        const listed = answerOf(
          await catalog().ids(generation, cursor, idPage)
        );
        // A record whose write or delete isn't done is damaged: it lists
        // with no source version, so reconciling writes or deletes it
        // again, and a drop removes it.
        const entries = listed.map(({ id, version }) => ({
          id,
          sourceVersion: version,
        }));
        const last = listed.at(-1);
        return listed.length === idPage && last !== undefined
          ? { entries, cursor: last.id }
          : { entries };
      });

    const status = async (): Promise<VectorIndexStatus> =>
      await fromProvider("describe itself", queryDeadline, async () => {
        const { vectors } = answerOf(await catalog().status(generation));
        return {
          generation: generation.id,
          dimensions: generation.dimensions,
          vectors,
          filtering: "working",
        };
      });

    return {
      profile: "sqlite",
      generation,
      query,
      upsert,
      delete: remove,
      ids,
      status,
    };
  };

  return {
    profile: "sqlite",
    create: async (generation) => {
      checkGeneration(generation);
      await fromProvider("create a generation", writeDeadline, async () => {
        answerOf(await catalog().create(generation));
      });
      return await indexOf(generation).status();
    },
    open: indexOf,
    drop: async (generation) => {
      checkGeneration(generation);
      await fromProvider("drop a generation", writeDeadline, async () => {
        const shards = await catalog().dropBegin(generation);
        await eachLimited(shards, shardConcurrency, async (ref) => {
          await shardOf(generation, ref).clear();
        });
        await catalog().dropEnd(generation.id);
      });
    },
    generations: async () =>
      await fromProvider(
        "list generations",
        queryDeadline,
        async () => await catalog().generations()
      ),
  };
};

/**
 * The deployment's `sqlite` provider: its objects in the EU jurisdiction
 * unless turned off (durable-objects.ts).
 */
export const sqliteVectorIndexProviderOf = (
  env: Pick<
    Env,
    "VECTOR_CATALOG" | "VECTOR_SHARDS" | "DURABLE_OBJECT_JURISDICTION"
  >,
  options?: SqliteVectorOptions
): VectorIndexProvider =>
  sqliteVectorIndexProvider(
    {
      catalog: inJurisdiction(env, env.VECTOR_CATALOG),
      shards: inJurisdiction(env, env.VECTOR_SHARDS),
    },
    options
  );
